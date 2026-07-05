import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


// 給与明細を削除（payslip_items は CASCADE）
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const res = await pool.query(`DELETE FROM payslips WHERE id=$1 AND user_id=$2`, [pid, USER_ID]);
  if (res.rowCount === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: res.rowCount });
}
