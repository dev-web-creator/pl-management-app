import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi } from "@/lib/auth";

const USER_ID = 1;
const KINDS = ["transfer", "charge", "cash_withdrawal", "card_settlement"];

// 資金移動を作成（振替/チャージ/現金引出/カード支払い）。PL（損益）には載らない。
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  let b: {
    from_wallet_id?: number;
    to_wallet_id?: number;
    amount?: number;
    fee?: number;
    kind?: string;
    transfer_date?: string;
    memo?: string;
  };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }

  const kind = b.kind ?? "transfer";
  if (
    !b.from_wallet_id ||
    !b.to_wallet_id ||
    !b.amount ||
    b.amount <= 0 ||
    !b.transfer_date ||
    !KINDS.includes(kind)
  ) {
    return NextResponse.json(
      { ok: false, error: "from/to ウォレット・amount(>0)・transfer_date・kind が必要です" },
      { status: 400 }
    );
  }
  if (b.from_wallet_id === b.to_wallet_id) {
    return NextResponse.json({ ok: false, error: "出金元と入金先が同じです" }, { status: 400 });
  }
  const fee = Number.isInteger(b.fee) && (b.fee as number) >= 0 ? (b.fee as number) : 0;

  const { rows } = await pool.query(
    `INSERT INTO transfers
       (user_id, from_wallet_id, to_wallet_id, amount, fee, kind, transfer_date, memo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [USER_ID, b.from_wallet_id, b.to_wallet_id, b.amount, fee, kind, b.transfer_date, b.memo ?? null]
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
