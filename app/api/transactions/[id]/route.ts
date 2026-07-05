import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


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
    !accrual_date ||
    !wallet_id
  ) {
    return NextResponse.json(
      { ok: false, error: "category_id / type / amount(>0) / accrual_date / wallet_id は必須です" },
      { status: 400 }
    );
  }

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
    // 脚を入れ替え（単一脚に集約）
    await client.query(`DELETE FROM transaction_legs WHERE transaction_id=$1`, [txId]);
    await client.query(
      `INSERT INTO transaction_legs(transaction_id, wallet_id, amount) VALUES ($1,$2,$3)`,
      [txId, wallet_id, amount]
    );
    await client.query("COMMIT");
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
