import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";
import { checkVariableCostThresholds } from "@/lib/notify";
import { checkRefs } from "@/lib/ownership";


// 取引を削除（transaction_legs は ON DELETE CASCADE で自動削除）
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const txId = Number(id);
  if (!Number.isInteger(txId) || txId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const res = await pool.query(
    `DELETE FROM transactions WHERE id = $1 AND user_id = $2`,
    [txId, USER_ID]
  );
  if (res.rowCount === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: res.rowCount });
}

// 取引を更新（MVPは単一脚に集約：脚を入れ替える）
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const txId = Number(id);
  if (!Number.isInteger(txId) || txId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  let body: {
    category_id?: number;
    type?: "expense" | "income";
    amount?: number;
    accrual_date?: string;
    memo?: string;
    wallet_id?: number;
    attach_wallet?: boolean; // 脚なし取引に決済手段を「あえて」紐付けるときだけ true
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }

  const { category_id, type, amount, accrual_date, memo, wallet_id } = body;
  if (
    !category_id ||
    !["expense", "income"].includes(type ?? "") ||
    !amount ||
    amount <= 0 ||
    !accrual_date
  ) {
    return NextResponse.json(
      { ok: false, error: "category_id / type / amount(>0) / accrual_date は必須です" },
      { status: 400 }
    );
  }

  // 参照先(費目・決済手段)の所有者検証
  const refErr = await checkRefs(pool, USER_ID, {
    walletIds: wallet_id ? [wallet_id] : [],
    categoryId: category_id,
  });
  if (refErr) return NextResponse.json({ ok: false, error: refErr }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upd = await client.query(
      `UPDATE transactions
       SET category_id=$1, type=$2, amount=$3, accrual_date=$4, memo=$5
       WHERE id=$6 AND user_id=$7`,
      [category_id, type, amount, accrual_date, memo ?? null, txId, USER_ID]
    );
    if (upd.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }

    // 決済手段の脚をどう扱うか。
    // インポート由来の過去取引は脚を持たない（本番の99.3%）。そこへ編集画面の
    // wallet_id フォールバック（先頭ウォレット）で脚を生やすと、メモを直しただけで
    // 過去の支出が今日の残高・総資産から引かれる。既定では脚を生やさず、
    // 利用者が明示的に紐付けを選んだとき（attach_wallet=true）だけ作成する。
    const legRes = await client.query(
      `SELECT count(*)::int AS n FROM transaction_legs WHERE transaction_id=$1`,
      [txId]
    );
    const legCount: number = legRes.rows[0].n;
    const replaceLegs = legCount > 0 || body.attach_wallet === true;

    if (replaceLegs) {
      if (!wallet_id) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { ok: false, error: "決済手段(wallet_id)が必要です" },
          { status: 400 }
        );
      }
      // 脚を入れ替え（単一脚に集約）
      await client.query(`DELETE FROM transaction_legs WHERE transaction_id=$1`, [txId]);
      await client.query(
        `INSERT INTO transaction_legs(transaction_id, wallet_id, amount) VALUES ($1,$2,$3)`,
        [txId, wallet_id, amount]
      );
    }
    await client.query("COMMIT");
    // 通知チェック（ADR-042）: 編集で当月変動費がしきい値を跨ぐこともある
    if (type === "expense") await checkVariableCostThresholds(USER_ID, accrual_date);
    return NextResponse.json({ ok: true, id: txId });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "不明なエラー" },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
