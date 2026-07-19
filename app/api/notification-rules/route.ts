import { NextResponse } from "next/server";
import pool, { ensureMigrated } from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

// 通知ルールの追加（ADR-042）。kind は当面 variable_cost_threshold のみ
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  await ensureMigrated();

  let body: { threshold?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  const threshold = Number(body.threshold);
  if (!Number.isInteger(threshold) || threshold <= 0) {
    return NextResponse.json({ ok: false, error: "threshold は正の整数（円）で指定してください" }, { status: 400 });
  }

  try {
    const r = await pool.query(
      `INSERT INTO notification_rules (user_id, kind, threshold)
       VALUES ($1, 'variable_cost_threshold', $2) RETURNING id`,
      [USER_ID, threshold]
    );
    return NextResponse.json({ ok: true, id: r.rows[0].id });
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: false, error: "同じしきい値のルールが既にあります" }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "不明なエラー" },
      { status: 500 }
    );
  }
}
