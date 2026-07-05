import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi } from "@/lib/auth";

const USER_ID = 1;

// 月次の目標（収入・支出）を保存。収支(net_balance)は income-expense で自動保存。
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  let b: { period?: string; income?: number; expense?: number; total_assets?: number };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-01$/.test(b.period ?? "")) {
    return NextResponse.json({ ok: false, error: "period(YYYY-MM-01) が必要です" }, { status: 400 });
  }
  const income = Number(b.income) || 0;
  const expense = Number(b.expense) || 0;
  const entries: [string, number][] = [
    ["income", income],
    ["expense", expense],
    ["net_balance", income - expense],
  ];
  // 総資産目標は任意（指定時のみ保存）
  if (b.total_assets !== undefined && b.total_assets !== null) {
    entries.push(["total_assets", Number(b.total_assets) || 0]);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [metric, amount] of entries) {
      await client.query(
        `INSERT INTO targets (user_id, period, metric, amount)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, period, metric) DO UPDATE SET amount=EXCLUDED.amount`,
        [USER_ID, b.period, metric, amount]
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  } finally {
    client.release();
  }
}
