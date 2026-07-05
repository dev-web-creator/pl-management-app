import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi } from "@/lib/auth";

const USER_ID = 1;
const SECTIONS = ["income", "fixed_cost", "variable_cost"];

// 月の確定（黒塗り）を切り替え。closed=true で当月の主要セクションを確定。
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  let b: { period?: string; closed?: boolean };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-01$/.test(b.period ?? "")) {
    return NextResponse.json({ ok: false, error: "period(YYYY-MM-01) が必要です" }, { status: 400 });
  }
  const closed = !!b.closed;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const section of SECTIONS) {
      await client.query(
        `INSERT INTO monthly_closings (user_id, period, section, is_closed, closed_at)
         VALUES ($1,$2,$3,$4, CASE WHEN $4 THEN now() ELSE NULL END)
         ON CONFLICT (user_id, period, section)
         DO UPDATE SET is_closed=EXCLUDED.is_closed, closed_at=EXCLUDED.closed_at`,
        [USER_ID, b.period, section, closed]
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, closed });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  } finally {
    client.release();
  }
}
