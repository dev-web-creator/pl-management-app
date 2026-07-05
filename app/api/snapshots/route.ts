import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi } from "@/lib/auth";

const USER_ID = 1;

// 実残高スナップショットを保存（wallet×基準日でupsert）。
// body: { as_of_date: 'YYYY-MM-DD', items: [{wallet_id, actual_balance}] }
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  let b: { as_of_date?: string; items?: { wallet_id?: number; actual_balance?: number }[] };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.as_of_date ?? "")) {
    return NextResponse.json({ ok: false, error: "as_of_date(YYYY-MM-DD) が必要です" }, { status: 400 });
  }
  const items = (b.items ?? []).filter(
    (i) => Number.isInteger(i.wallet_id) && Number.isFinite(Number(i.actual_balance))
  );
  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: "items がありません" }, { status: 400 });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of items) {
      await client.query(
        `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (wallet_id, as_of_date) DO UPDATE SET actual_balance=EXCLUDED.actual_balance`,
        [USER_ID, it.wallet_id, b.as_of_date, Math.round(Number(it.actual_balance))]
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, count: items.length });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  } finally {
    client.release();
  }
}
