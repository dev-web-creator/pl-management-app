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
  // 明細と、そこから自動連動した給与収入(ADR-049)を同じトランザクションで消す。
  // 連動取引を残すと、明細を消したのに手取りだけ収入に居座り、月次PLが過大になる。
  // 手入力の給与収入は client_key が異なるため影響を受けない。
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `DELETE FROM payslips WHERE id=$1 AND user_id=$2 RETURNING to_char(period,'YYYY-MM') AS period`,
      [pid, USER_ID]
    );
    if (found.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const salaryKey = `payslip:${USER_ID}:${found.rows[0].period}-01`;
    const linked = await client.query(
      `DELETE FROM transactions WHERE user_id=$1 AND client_key=$2`,
      [USER_ID, salaryKey]
    );
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      deleted: found.rowCount,
      salary_unlinked: linked.rowCount ?? 0,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "不明なエラー" },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
