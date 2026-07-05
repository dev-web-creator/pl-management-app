import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


// 資金移動を削除
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const tId = Number(id);
  if (!Number.isInteger(tId) || tId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const res = await pool.query(`DELETE FROM transfers WHERE id=$1 AND user_id=$2`, [tId, USER_ID]);
  if (res.rowCount === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: res.rowCount });
}
