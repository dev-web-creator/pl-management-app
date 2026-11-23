import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";


// 固定費マスタ(recurring_rules)の「予定額」を、その月の実額取引として記録する（ADR-030の次段）。
// body: { rule_id: number, period: 'YYYY-MM-01', amount?: number }
// サーバー側でルールを引き、category_id / settlement_wallet_id / 金額を確定（クライアントを信用しない）。
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  let body: { rule_id?: number; period?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }

  const ruleId = Number(body.rule_id);
  const period = body.period ?? "";
  if (!Number.isInteger(ruleId) || ruleId <= 0 || !/^\d{4}-\d{2}-01$/.test(period)) {
    return NextResponse.json(
      { ok: false, error: "rule_id と period(YYYY-MM-01) が必要です" },
      { status: 400 }
    );
  }

  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT category_id, settlement_wallet_id, amount, name
       FROM recurring_rules
       WHERE id = $1 AND user_id = $2 AND is_active
         -- 年額(yearly)は月次PLに出さない設計(ADR-035)。ここで記録できてしまうと
         -- 予実明細には出ないのに getPLSummary の固定費だけ増え、内訳と合計が食い違う。
         AND billing_cycle = 'monthly'`,
      [ruleId, USER_ID]
    );
    if (r.rowCount === 0) {
      return NextResponse.json(
        { ok: false, error: "月額の固定費マスタが見つかりません（年額ルールは月次に記録できません）" },
        { status: 404 }
      );
    }
    const rule = r.rows[0];
    const amount =
      Number.isInteger(body.amount) && (body.amount as number) > 0
        ? (body.amount as number)
        : rule.amount;

    // 重複防止：同じ月・同じカテゴリの固定費取引が既にあれば拒否
    const dup = await client.query(
      `SELECT 1 FROM transactions
       WHERE user_id = $1 AND category_id = $2 AND type = 'expense'
         AND accrual_date >= $3::date AND accrual_date < ($3::date + interval '1 month')
       LIMIT 1`,
      [USER_ID, rule.category_id, period]
    );
    if ((dup.rowCount ?? 0) > 0) {
      return NextResponse.json(
        { ok: false, error: "この月は既に実額が記録済みです" },
        { status: 409 }
      );
    }

    // 冪等キー。上の重複チェックはトランザクション外・別コネクションで走るため、
    // 二重送信やリトライ、複数インスタンスの同時実行ではすり抜ける。
    // ユニーク索引 uq_tx_user_client_key を最後の砦にする（取引POSTと同じ仕組み / ADR-040）。
    const clientKey = `rule:${ruleId}:${period}`;

    await client.query("BEGIN");
    const tx = await client.query(
      `INSERT INTO transactions(user_id, category_id, type, amount, accrual_date, memo, client_key)
       VALUES ($1, $2, 'expense', $3, $4, $5, $6) RETURNING id`,
      [USER_ID, rule.category_id, amount, period, `固定費(マスタから記録): ${rule.name}`, clientKey]
    );
    await client.query(
      `INSERT INTO transaction_legs(transaction_id, wallet_id, amount) VALUES ($1, $2, $3)`,
      [tx.rows[0].id, rule.settlement_wallet_id, amount]
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: tx.rows[0].id });
  } catch (e: unknown) {
    await client.query("ROLLBACK");
    // 同時実行で同じ client_key が衝突した場合は「記録済み」として409を返す
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
      return NextResponse.json(
        { ok: false, error: "この月は既に実額が記録済みです" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "不明なエラー" },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
