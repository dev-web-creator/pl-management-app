import { NextResponse } from "next/server";
import pool from "@/lib/db";

const USER_ID = 1; // MVPは単一ユーザー

// 取引を削除（transaction_legs は ON DELETE CASCADE で自動削除）
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = Number(id);
  if (!Number.isInteger(txId) || txId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const res = await pool.query(
    `DELETE FROM transactions WHERE id = $1 AND user_id = $2`,
    [txId, USER_ID]
  );
  if (res.rowCount === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: res.rowCount });
}
