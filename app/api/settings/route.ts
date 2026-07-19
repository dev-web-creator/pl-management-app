import { NextResponse } from "next/server";
import pool, { ensureMigrated } from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

// ユーザー設定の更新（当面は FY開始月のみ / ADR-017）
export async function PUT(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  await ensureMigrated();

  let body: { fiscal_year_start_month?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  const m = Number(body.fiscal_year_start_month);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    return NextResponse.json({ ok: false, error: "fiscal_year_start_month は 1〜12 で指定してください" }, { status: 400 });
  }

  await pool.query(`UPDATE users SET fiscal_year_start_month=$1 WHERE id=$2`, [m, USER_ID]);
  return NextResponse.json({ ok: true });
}
