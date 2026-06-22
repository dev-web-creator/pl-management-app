import { NextResponse } from "next/server";
import pool from "@/lib/db";

const USER_ID = 1;

type Item = { name?: string; amount?: number };

function cleanItems(items: Item[] | undefined): { name: string; amount: number }[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((i) => ({ name: (i.name ?? "").trim(), amount: Number(i.amount) || 0 }))
    .filter((i) => i.name !== "" && i.amount !== 0); // 名称あり＆金額0以外のみ保存
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v != null ? n : null;
}

// 給与明細を作成/更新（月ごとに upsert）
export async function POST(req: Request) {
  let b: {
    period?: string;
    total_work_hours?: unknown;
    overtime_hours?: unknown;
    is_confirmed?: boolean;
    allowances?: Item[];
    deductions?: Item[];
  };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(b.period ?? "")) {
    return NextResponse.json({ ok: false, error: "period(YYYY-MM) が必要です" }, { status: 400 });
  }
  const period = `${b.period}-01`;
  const allowances = cleanItems(b.allowances);
  const deductions = cleanItems(b.deductions);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const up = await client.query(
      `INSERT INTO payslips (user_id, period, total_work_hours, overtime_hours, is_confirmed, source)
       VALUES ($1,$2,$3,$4,$5,'manual')
       ON CONFLICT (user_id, period) DO UPDATE
         SET total_work_hours=EXCLUDED.total_work_hours,
             overtime_hours=EXCLUDED.overtime_hours,
             is_confirmed=EXCLUDED.is_confirmed
       RETURNING id`,
      [USER_ID, period, numOrNull(b.total_work_hours), numOrNull(b.overtime_hours), b.is_confirmed ?? false]
    );
    const payslipId = up.rows[0].id;
    // 明細を入れ替え
    await client.query(`DELETE FROM payslip_items WHERE payslip_id=$1`, [payslipId]);
    for (const a of allowances) {
      await client.query(
        `INSERT INTO payslip_items (payslip_id, item_type, name, amount) VALUES ($1,'allowance',$2,$3)`,
        [payslipId, a.name, a.amount]
      );
    }
    for (const d of deductions) {
      await client.query(
        `INSERT INTO payslip_items (payslip_id, item_type, name, amount) VALUES ($1,'deduction',$2,$3)`,
        [payslipId, d.name, d.amount]
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: payslipId });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "不明なエラー" }, { status: 500 });
  } finally {
    client.release();
  }
}
