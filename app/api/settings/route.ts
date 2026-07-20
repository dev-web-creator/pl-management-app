import { NextResponse } from "next/server";
import pool, { ensureMigrated } from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";
import { HIDEABLE_HREFS } from "@/lib/nav";

// ユーザー設定の更新（FY開始月=ADR-017 / 機能の表示ON/OFF=ADR-046）
// どちらか一方だけの部分更新も可
export async function PUT(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  await ensureMigrated();

  let body: { fiscal_year_start_month?: number; hidden_pages?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.fiscal_year_start_month !== undefined) {
    const m = Number(body.fiscal_year_start_month);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return NextResponse.json({ ok: false, error: "fiscal_year_start_month は 1〜12 で指定してください" }, { status: 400 });
    }
    vals.push(m);
    sets.push(`fiscal_year_start_month=$${vals.length}`);
  }

  if (body.hidden_pages !== undefined) {
    if (!Array.isArray(body.hidden_pages) || body.hidden_pages.some((h) => !HIDEABLE_HREFS.includes(h))) {
      return NextResponse.json(
        { ok: false, error: `hidden_pages は ${HIDEABLE_HREFS.join(", ")} の配列で指定してください` },
        { status: 400 }
      );
    }
    vals.push(JSON.stringify(body.hidden_pages));
    sets.push(`hidden_pages=$${vals.length}::jsonb`);
  }

  if (sets.length === 0) {
    return NextResponse.json({ ok: false, error: "更新項目がありません" }, { status: 400 });
  }

  vals.push(USER_ID);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${vals.length}`, vals);
  return NextResponse.json({ ok: true });
}
