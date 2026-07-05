import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi } from "@/lib/auth";

const USER_ID = 1; // MVPは単一ユーザー

type Leg = { wallet_id: number; amount: number };
type Body = {
  category_id: number;
  type: "expense" | "income";
  amount: number;
  accrual_date: string; // 'YYYY-MM-DD'
  memo?: string;
  legs?: Leg[]; // 省略時は単一脚（amount全額を1ウォレットで）
  wallet_id?: number; // 単一脚のショートカット
};

export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }

  // --- バリデーション ---
  const { category_id, type, amount, accrual_date, memo } = body;
  if (!category_id || !["expense", "income"].includes(type) || !amount || amount <= 0 || !accrual_date) {
    return NextResponse.json(
      { ok: false, error: "category_id / type / amount(>0) / accrual_date は必須です" },
      { status: 400 }
    );
  }
  // 支払い脚を組み立て（未指定なら wallet_id で単一脚）
  const legs: Leg[] =
    body.legs && body.legs.length > 0
      ? body.legs
      : body.wallet_id
      ? [{ wallet_id: body.wallet_id, amount }]
      : [];
  if (legs.length === 0) {
    return NextResponse.json({ ok: false, error: "決済手段(wallet)が必要です" }, { status: 400 });
  }
  const legSum = legs.reduce((s, l) => s + Number(l.amount), 0);
  if (legSum !== Number(amount)) {
    return NextResponse.json(
      { ok: false, error: `支払い脚の合計(${legSum})が金額(${amount})と一致しません` },
      { status: 400 }
    );
  }

  // --- DBトランザクションで取引＋脚を原子的に挿入 ---
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txRes = await client.query(
      `INSERT INTO transactions(user_id, category_id, type, amount, accrual_date, memo)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [USER_ID, category_id, type, amount, accrual_date, memo ?? null]
    );
    const txId = txRes.rows[0].id;
    for (const leg of legs) {
      await client.query(
        `INSERT INTO transaction_legs(transaction_id, wallet_id, amount) VALUES ($1,$2,$3)`,
        [txId, leg.wallet_id, leg.amount]
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: txId });
  } catch (e) {
    await client.query("ROLLBACK");
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
