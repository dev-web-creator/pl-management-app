import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi } from "@/lib/auth";

const USER_ID = 1;

// クレカの請求サイクルを「引き落とし実行（消込）」する。
// 銀行(引落先)→カード の transfer(kind=card_settlement) を1件作り、カード未払いを減らす。
// body: { card_id, close_key:'YYYY-MM-DD', amount, pay_date:'YYYY-MM-DD' }
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  let b: { card_id?: number; close_key?: string; amount?: number; pay_date?: string };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  if (
    !b.card_id ||
    !/^\d{4}-\d{2}-\d{2}$/.test(b.close_key ?? "") ||
    !b.amount ||
    b.amount <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(b.pay_date ?? "")
  ) {
    return NextResponse.json(
      { ok: false, error: "card_id / close_key / amount(>0) / pay_date が必要です" },
      { status: 400 }
    );
  }
  const memo = `クレカ消込:${b.close_key}締め`;

  // カードと引落先口座を取得
  const card = await pool.query(
    `SELECT settlement_wallet_id FROM wallets WHERE id=$1 AND user_id=$2 AND type='credit_card'`,
    [b.card_id, USER_ID]
  );
  if (card.rowCount === 0 || !card.rows[0].settlement_wallet_id) {
    return NextResponse.json({ ok: false, error: "カードまたは引落先口座が見つかりません" }, { status: 404 });
  }
  const fromWallet = card.rows[0].settlement_wallet_id;

  // 二重消込の防止（同じ締めサイクルの消込が既にあるか）
  const dup = await pool.query(
    `SELECT 1 FROM transfers WHERE user_id=$1 AND to_wallet_id=$2 AND kind='card_settlement' AND memo=$3 LIMIT 1`,
    [USER_ID, b.card_id, memo]
  );
  if ((dup.rowCount ?? 0) > 0) {
    return NextResponse.json({ ok: false, error: "この締めサイクルは既に消込済みです" }, { status: 409 });
  }

  const { rows } = await pool.query(
    `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, kind, transfer_date, memo)
     VALUES ($1,$2,$3,$4,'card_settlement',$5,$6) RETURNING id`,
    [USER_ID, fromWallet, b.card_id, b.amount, b.pay_date, memo]
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
