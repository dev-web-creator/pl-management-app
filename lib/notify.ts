// 通知基盤（ADR-042）
// - ルール: notification_rules（ユーザーごと・しきい値・ON/OFF）＝カスタマイズは行の追加/編集
// - 履歴: notification_log（UNIQUE(rule_id, period) で「同一しきい値は月1回だけ」）
// - 送信: Resend の HTTP API（依存パッケージゼロ）。RESEND_API_KEY 未設定なら静かにスキップ
//   （OCR/認証と同じ「envで有効化」方式。ローカル開発や設定前の本番を止めない）
import pool from "@/lib/db";

export function notifyEnabled(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/** メール1通を送る。未設定/失敗は false（呼び元の処理は失敗させない方針） */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  // 独自ドメイン検証済みなら NOTIFY_EMAIL_FROM で差出人を変更できる
  const from = process.env.NOTIFY_EMAIL_FROM || "My PL Ledger <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      console.error("sendEmail failed:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("sendEmail failed:", e);
    return false;
  }
}

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

/**
 * 変動費しきい値チェック（取引の書き込み後に呼ぶ）。
 * 当月（JST）の変動費合計を集計し、「有効・当月未通知・合計が到達」のルールにメールを送る。
 * - 過去月の入力・修正では発火しない（バックフィルでの通知スパム防止）
 * - 送信前にログ行を先に確保（UNIQUE制約）することで同時リクエストの多重送信を防ぐ
 * - どんな失敗も呼び元（取引の保存）は失敗させない
 */
export async function checkVariableCostThresholds(userId: number, accrualDate: string): Promise<void> {
  try {
    if (!notifyEnabled()) return;

    // 「今月」はユーザーの生活時間＝JSTで判定（サーバーはUTC）
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const curMonth = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!accrualDate.startsWith(curMonth)) return;
    const period = `${curMonth}-01`;

    const total = await pool.query(
      `SELECT COALESCE(SUM(t.amount),0)::int AS total
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.user_id=$1 AND t.type='expense' AND c.pl_type='variable_cost'
         AND t.accrual_date >= $2::date AND t.accrual_date < ($2::date + interval '1 month')`,
      [userId, period]
    );
    const sum: number = total.rows[0].total;

    // 到達済み かつ 当月未通知 のルールだけ拾う
    const rules = await pool.query(
      `SELECT r.id, r.threshold FROM notification_rules r
       WHERE r.user_id=$1 AND r.kind='variable_cost_threshold' AND r.enabled
         AND r.threshold <= $2
         AND NOT EXISTS (SELECT 1 FROM notification_log l WHERE l.rule_id = r.id AND l.period = $3::date)
       ORDER BY r.threshold`,
      [userId, sum, period]
    );
    if (rules.rowCount === 0) return;

    const u = await pool.query(`SELECT email FROM users WHERE id=$1`, [userId]);
    const to: string | null = u.rows[0]?.email ?? null;
    if (!to) return; // 宛先が無い（認証オフのローカル等）なら何もしない

    for (const r of rules.rows) {
      // 先にログ行を確保（多重送信ガード）。競合したら他リクエストが送信中なのでスキップ
      const ins = await pool.query(
        `INSERT INTO notification_log (user_id, rule_id, period, sent_to, detail)
         VALUES ($1,$2,$3::date,$4,$5)
         ON CONFLICT (rule_id, period) DO NOTHING RETURNING id`,
        [userId, r.id, period, to, `variable_total=${sum}`]
      );
      if (ins.rowCount === 0) continue;

      const ok = await sendEmail(
        to,
        `【My PL Ledger】今月の変動費が ${yen(r.threshold)} を超えました`,
        `<div style="font-family:sans-serif">
           <p>🌱 今月（${curMonth}）の変動費が <b>${yen(r.threshold)}</b> に到達しました。</p>
           <p>現在の変動費合計: <b style="color:#e2724f">${yen(sum)}</b></p>
           <p style="color:#888;font-size:12px">このメールは My PL Ledger の通知ルール（⚙️ 設定 &gt; 通知）に基づいて自動送信されています。</p>
         </div>`
      );
      // 送信に失敗したらログを取り消し、次回の書き込みで再挑戦できるようにする
      if (!ok) {
        await pool.query(`DELETE FROM notification_log WHERE id=$1`, [ins.rows[0].id]);
      }
    }
  } catch (e) {
    console.error("checkVariableCostThresholds failed:", e);
  }
}
