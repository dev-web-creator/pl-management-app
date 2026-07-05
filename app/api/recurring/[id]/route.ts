import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi } from "@/lib/auth";

const USER_ID = 1;

function normMonth(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const m = v.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

// 固定費マスタを更新（解約＝end_monthのセット、再開＝end_monthをnullに）
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const { id } = await params;
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
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
    is_active?: boolean;
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
  const res = await pool.query(
    `UPDATE recurring_rules
     SET name=$1, category_id=$2, amount=$3, settlement_wallet_id=$4,
         start_month=$5, end_month=$6, billing_day=$7, billing_cycle=$8, payment_month=$9, is_active=$10
     WHERE id=$11 AND user_id=$12`,
    [
      b.name.trim(),
      b.category_id,
      b.amount,
      b.settlement_wallet_id,
      start,
      normMonth(b.end_month),
      day,
      cycle,
      payMonth,
      b.is_active ?? true,
      ruleId,
      USER_ID,
    ]
  );
  if (res.rowCount === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id: ruleId });
}

// 固定費マスタを削除（誤登録の削除用。通常の「解約」は end_month セットを推奨）
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const { id } = await params;
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const res = await pool.query(`DELETE FROM recurring_rules WHERE id=$1 AND user_id=$2`, [
    ruleId,
    USER_ID,
  ]);
  if (res.rowCount === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: res.rowCount });
}
