import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


// 実残高スナップショットを保存（wallet×基準日でupsert）。
// body: { as_of_date: 'YYYY-MM-DD', items: [{wallet_id, actual_balance}] }
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  let b: { as_of_date?: string; items?: { wallet_id?: number; actual_balance?: number }[] };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.as_of_date ?? "")) {
    return NextResponse.json({ ok: false, error: "as_of_date(YYYY-MM-DD) が必要です" }, { status: 400 });
  }
  // wallet_id は bigint（pgからは文字列で返る）ため数値化してから検証する
  const items = (b.items ?? [])
    .map((i) => ({ wallet_id: Number(i.wallet_id), actual_balance: i.actual_balance }))
    .filter((i) => Number.isInteger(i.wallet_id) && i.wallet_id > 0 && Number.isFinite(Number(i.actual_balance)));
  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: "items がありません" }, { status: 400 });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of items) {
      // 自分のウォレットにのみ書ける（他ユーザーの wallet_id を弾く）
      await client.query(
        `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
         SELECT $1, w.id, $3, $4 FROM wallets w WHERE w.id=$2 AND w.user_id=$1
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
