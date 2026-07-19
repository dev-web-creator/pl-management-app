import { NextResponse } from "next/server";
import pool, { ensureMigrated } from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

// ウォレット追加（当面は暗号資産のみ / ADR-043）。
// 銀行・カード等のマスタは seed/DB管理のままにし、UIからの追加は crypto に限定する。
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  await ensureMigrated();

  let body: { name?: string; type?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  const name = (body.name ?? "").trim().slice(0, 50);
  if (!name) {
    return NextResponse.json({ ok: false, error: "name は必須です" }, { status: 400 });
  }
  if (body.type !== "crypto") {
    return NextResponse.json({ ok: false, error: "追加できるのは type='crypto' のみです" }, { status: 400 });
  }

  try {
    const r = await pool.query(
      `INSERT INTO wallets (user_id, name, type, display_order)
       VALUES ($1, $2, 'crypto', 100) RETURNING id`,
      [USER_ID, name]
    );
    return NextResponse.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "不明なエラー" },
      { status: 500 }
    );
  }
}
