import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


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
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  let b: {
    period?: string;
    total_work_hours?: unknown;
    overtime_hours?: unknown;
    is_confirmed?: boolean;
    allowances?: Item[];
    deductions?: Item[];
    salary_wallet_id?: number | null; // 手取りの振込先（ADR-049）
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

    // --- 手取りを月次「給与収入(手取り)」に自動連動（ADR-049）---
    // 冪等キー payslip:<uid>:<period> の収入取引を作り直す（1入力・全連動）。
    const net =
      allowances.reduce((s, a) => s + a.amount, 0) - deductions.reduce((s, d) => s + d.amount, 0);
    const salaryKey = `payslip:${USER_ID}:${period}`;
    // 既存の連動取引を削除（脚はCASCADE）。手動入力の給与収入(別client_key)には触れない。
    await client.query(`DELETE FROM transactions WHERE user_id=$1 AND client_key=$2`, [USER_ID, salaryKey]);

    let salaryLinked = false;
    if (net > 0) {
      const cat = await client.query(
        `SELECT id FROM categories WHERE user_id=$1 AND name='給与収入(手取り)' AND is_active LIMIT 1`,
        [USER_ID]
      );
      // 振込先ウォレット（指定が自分の銀行/プリペイドか検証、無ければ先頭の銀行）
      let walletId: number | null = null;
      if (b.salary_wallet_id != null) {
        const w = await client.query(
          `SELECT id FROM wallets WHERE id=$1 AND user_id=$2 AND is_active AND type IN ('bank','prepaid')`,
          [b.salary_wallet_id, USER_ID]
        );
        walletId = w.rows[0]?.id ?? null;
      }
      if (walletId == null) {
        const fb = await client.query(
          `SELECT id FROM wallets WHERE user_id=$1 AND is_active AND type='bank' ORDER BY display_order, id LIMIT 1`,
          [USER_ID]
        );
        walletId = fb.rows[0]?.id ?? null;
      }
      if (cat.rowCount && cat.rowCount > 0) {
        const tx = await client.query(
          `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date, memo, client_key)
           VALUES ($1,$2,'income',$3,$4,'給与明細から自動連動（手取り）',$5) RETURNING id`,
          [USER_ID, cat.rows[0].id, net, `${b.period}-25`, salaryKey]
        );
        if (walletId != null) {
          await client.query(
            `INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,$3)`,
            [tx.rows[0].id, walletId, net]
          );
        }
        salaryLinked = true;
      }
    }

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: payslipId, salary_linked: salaryLinked, net });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "不明なエラー" }, { status: 500 });
  } finally {
    client.release();
  }
}
