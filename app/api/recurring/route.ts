import { NextResponse } from "next/server";
import pool from "@/lib/db";

const USER_ID = 1;

// 月入力（'YYYY-MM' or 'YYYY-MM-01'）を月初日 'YYYY-MM-01' に正規化。空は null。
function normMonth(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const m = v.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

// 固定費マスタを新規作成
export async function POST(req: Request) {
  let b: {
    name?: string;
    category_id?: number;
    amount?: number;
    settlement_wallet_id?: number;
    start_month?: string;
    end_month?: string;
    billing_day?: number;
  };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  const start = normMonth(b.start_month);
  if (
    !b.name?.trim() ||
    !b.category_id ||
    !Number.isInteger(b.amount) ||
    (b.amount as number) < 0 ||
    !b.settlement_wallet_id ||
    !start
  ) {
    return NextResponse.json(
      { ok: false, error: "name / category_id / amount(>=0) / settlement_wallet_id / start_month は必須です" },
      { status: 400 }
    );
  }
  const day =
    Number.isInteger(b.billing_day) && (b.billing_day as number) >= 1 && (b.billing_day as number) <= 31
      ? b.billing_day
      : null;
  const { rows } = await pool.query(
    `INSERT INTO recurring_rules
       (user_id, name, category_id, amount, settlement_wallet_id, start_month, end_month, billing_day)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [USER_ID, b.name.trim(), b.category_id, b.amount, b.settlement_wallet_id, start, normMonth(b.end_month), day]
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
