import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


// 月入力（'YYYY-MM' or 'YYYY-MM-01'）を月初日 'YYYY-MM-01' に正規化。空は null。
function normMonth(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const m = v.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

// 固定費マスタを新規作成
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  let b: {
    name?: string;
    category_id?: number;
    amount?: number;
    settlement_wallet_id?: number;
    start_month?: string;
    end_month?: string;
    billing_day?: number;
    billing_cycle?: string;
    payment_month?: number;
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
  // 月額/年額（ADR-035）。年額のときだけ支払月(1-12)を持つ。
  const cycle = b.billing_cycle === "yearly" ? "yearly" : "monthly";
  const payMonth =
    cycle === "yearly" &&
    Number.isInteger(b.payment_month) &&
    (b.payment_month as number) >= 1 &&
    (b.payment_month as number) <= 12
      ? b.payment_month
      : null;
  // 予実の突合は category_id をキーに行うため（lib/queries.ts の getFixedCostPlanVsActual）、
  // 同一カテゴリに月額ルールが2本あると、1件の実額が両方の行に貼られて固定費が二重計上になる。
  // 「1カテゴリ1ルール」を入口で強制して、この罠を塞ぐ。
  if (cycle === "monthly") {
    const dup = await pool.query(
      `SELECT r.name FROM recurring_rules r
       WHERE r.user_id=$1 AND r.category_id=$2 AND r.is_active AND r.billing_cycle='monthly'
       LIMIT 1`,
      [USER_ID, b.category_id]
    );
    if ((dup.rowCount ?? 0) > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `この費目には既に月額の固定費「${dup.rows[0].name}」が登録されています。実額の突合が費目単位のため、1つの費目に月額ルールは1つまでです。費目を分けるか、既存のルールの金額を変更してください。`,
        },
        { status: 409 }
      );
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO recurring_rules
       (user_id, name, category_id, amount, settlement_wallet_id, start_month, end_month, billing_day, billing_cycle, payment_month)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [USER_ID, b.name.trim(), b.category_id, b.amount, b.settlement_wallet_id, start, normMonth(b.end_month), day, cycle, payMonth]
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
