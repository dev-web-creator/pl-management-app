import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


// ビジョン/目標の自由記述を保存（1ユーザー1箱でupsert）
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  let b: { content?: string };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  const content = typeof b.content === "string" ? b.content : "";
  await pool.query(
    `INSERT INTO vision_notes (user_id, content) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET content=EXCLUDED.content, updated_at=now()`,
    [USER_ID, content]
  );
  return NextResponse.json({ ok: true });
}
