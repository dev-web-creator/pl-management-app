import pool, { ensureMigrated } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

// マルチユーザー対応（ADR-037）：各クエリはログイン中ユーザーのIDで実行する。
// 認証が無効（env未設定）のときはオーナー(1)にフォールバック。
const uid = () => currentUserId();

export type PLSummary = {
  disposable: number; // 可処分所得（トップライン）
  fixed: number; // 固定費
  variable: number; // 変動費
  surplus: number; // 月次黒字
  excluded: number; // PL対象外（参考）
};

// PLサマリ（指定月）。period は月初日 'YYYY-MM-01'
export async function getPLSummary(period = "2026-06-01"): Promise<PLSummary> {
  const { rows } = await pool.query(
    `WITH x AS (
       SELECT t.type, c.pl_type, t.amount
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.accrual_date >= $2::date
         AND t.accrual_date <  ($2::date + interval '1 month')
     )
     SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='income'  AND pl_type='income'),0)::int        AS disposable,
       COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type='fixed_cost'),0)::int    AS fixed,
       COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type='variable_cost'),0)::int AS variable,
       (COALESCE(SUM(amount) FILTER (WHERE type='income'  AND pl_type='income'),0)
        - COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type IN ('fixed_cost','variable_cost')),0))::int AS surplus,
       COALESCE(SUM(amount) FILTER (WHERE pl_type='excluded'),0)::int AS excluded
     FROM x`,
    [await uid(), period]
  );
  return rows[0];
}

// ---- アナリティクス（月次比較・可視化 / ADR-041） ----
export type MonthPoint = { month: string; income: number; expense: number; surplus: number };

// 直近 n ヶ月の 収入 / 支出(固定+変動) / 黒字 の推移。
export async function getMonthlySeries(n = 12): Promise<MonthPoint[]> {
  const { rows } = await pool.query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', CURRENT_DATE) - (($2::int - 1) * interval '1 month'),
         date_trunc('month', CURRENT_DATE),
         interval '1 month'
       )::date AS m
     ),
     agg AS (
       SELECT date_trunc('month', t.accrual_date)::date AS mo, t.type, c.pl_type, SUM(t.amount) AS amt
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.accrual_date >= (date_trunc('month', CURRENT_DATE) - (($2::int - 1) * interval '1 month'))
       GROUP BY 1,2,3
     )
     SELECT to_char(mo.m,'YYYY-MM') AS month,
       COALESCE(SUM(amt) FILTER (WHERE type='income'  AND pl_type='income'),0)::int AS income,
       COALESCE(SUM(amt) FILTER (WHERE type='expense' AND pl_type IN ('fixed_cost','variable_cost')),0)::int AS expense
     FROM months mo LEFT JOIN agg ON agg.mo = mo.m
     GROUP BY mo.m ORDER BY mo.m`,
    [await uid(), n]
  );
  return rows.map((r) => ({ ...r, surplus: r.income - r.expense }));
}

export type CategoryMoM = { name: string; pl_type: string; this_month: number; last_month: number };

// 支出カテゴリ（葉）の今月トップと前月比。
export async function getCategoryMoM(period: string): Promise<CategoryMoM[]> {
  const { rows } = await pool.query(
    `WITH cur AS (
       SELECT category_id, SUM(amount) AS amt FROM transactions
       WHERE user_id=$1 AND type='expense'
         AND accrual_date >= $2::date AND accrual_date < ($2::date + interval '1 month')
       GROUP BY 1
     ),
     prev AS (
       SELECT category_id, SUM(amount) AS amt FROM transactions
       WHERE user_id=$1 AND type='expense'
         AND accrual_date >= ($2::date - interval '1 month') AND accrual_date < $2::date
       GROUP BY 1
     )
     SELECT c.name, c.pl_type,
            COALESCE(cur.amt,0)::int AS this_month,
            COALESCE(prev.amt,0)::int AS last_month
     FROM categories c
     LEFT JOIN cur  ON cur.category_id = c.id
     LEFT JOIN prev ON prev.category_id = c.id
     WHERE c.user_id=$1 AND c.is_input_allowed
       AND (cur.amt IS NOT NULL OR prev.amt IS NOT NULL)
     ORDER BY COALESCE(cur.amt,0) DESC, COALESCE(prev.amt,0) DESC
     LIMIT 8`,
    [await uid(), period]
  );
  return rows;
}

// ---- 設定・通知（ADR-042 / ADR-017 / ADR-046） ----
export type UserSettings = {
  email: string | null;
  fiscal_year_start_month: number;
  hidden_pages: string[];
};

export async function getUserSettings(): Promise<UserSettings> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT email, fiscal_year_start_month, hidden_pages FROM users WHERE id=$1`,
    [await uid()]
  );
  return rows[0] ?? { email: null, fiscal_year_start_month: 4, hidden_pages: [] };
}

// ナビ用の非表示ページ一覧（layoutから毎リクエスト呼ばれるため失敗しても落とさない）
export async function getHiddenPages(): Promise<string[]> {
  try {
    await ensureMigrated();
    const { rows } = await pool.query(`SELECT hidden_pages FROM users WHERE id=$1`, [await uid()]);
    return Array.isArray(rows[0]?.hidden_pages) ? rows[0].hidden_pages : [];
  } catch {
    return [];
  }
}

export type NotificationRule = { id: number; kind: string; threshold: number; enabled: boolean };

export async function getNotificationRules(): Promise<NotificationRule[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT id, kind, threshold, enabled FROM notification_rules
     WHERE user_id=$1 ORDER BY kind, threshold`,
    [await uid()]
  );
  return rows;
}

export type NotificationLogRow = {
  threshold: number;
  period: string; // 'YYYY-MM'
  sent_to: string | null;
  sent_at: Date;
};

export async function getNotificationLog(limit = 10): Promise<NotificationLogRow[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT r.threshold, to_char(l.period,'YYYY-MM') AS period, l.sent_to, l.sent_at
     FROM notification_log l JOIN notification_rules r ON r.id = l.rule_id
     WHERE l.user_id=$1 ORDER BY l.sent_at DESC LIMIT $2`,
    [await uid(), limit]
  );
  return rows;
}

// ---- 5か年PL・フォーキャスト（ADR-044） ----
export type ForecastInputs = {
  fyStartMonth: number;
  /** 全期間の月次実績（収入/固定費/変動費） */
  actuals: { month: string; income: number; fixed: number; variable: number }[];
  /** 月次目標（income/expense のみ） */
  targets: { period: string; metric: string; amount: number }[];
  /** 月額の固定費マスタ（未来月の固定費見込みに使用） */
  rules: { amount: number; start_month: string; end_month: string | null }[];
  netAssets: number;
};

export async function getForecastInputs(): Promise<ForecastInputs> {
  await ensureMigrated();
  const id = await uid();
  const [fyStartMonth, assets] = await Promise.all([getUserFyStartMonth(), getAssets()]);
  const [a, t, r] = await Promise.all([
    pool.query(
      `SELECT to_char(date_trunc('month', t.accrual_date),'YYYY-MM') AS month,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='income'  AND c.pl_type='income'),0)::int        AS income,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND c.pl_type='fixed_cost'),0)::int    AS fixed,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND c.pl_type='variable_cost'),0)::int AS variable
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.user_id=$1 GROUP BY 1 ORDER BY 1`,
      [id]
    ),
    pool.query(
      `SELECT to_char(period,'YYYY-MM') AS period, metric, amount::int AS amount
       FROM targets WHERE user_id=$1 AND metric IN ('income','expense')`,
      [id]
    ),
    pool.query(
      `SELECT amount::int AS amount, to_char(start_month,'YYYY-MM') AS start_month,
              to_char(end_month,'YYYY-MM') AS end_month
       FROM recurring_rules WHERE user_id=$1 AND billing_cycle='monthly'`,
      [id]
    ),
  ]);
  return { fyStartMonth, actuals: a.rows, targets: t.rows, rules: r.rows, netAssets: assets.net_assets };
}

export type WalletBalance = { name: string; type: string; balance: number };

// ウォレット残高（取引脚＋振替から算出）。残高0は除外。
export async function getWalletBalances(): Promise<WalletBalance[]> {
  const { rows } = await pool.query(
    `WITH legs AS (
       SELECT tl.wallet_id,
         SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
       FROM transaction_legs tl JOIN transactions t ON t.id = tl.transaction_id
       WHERE t.user_id = $1 GROUP BY tl.wallet_id
     ),
     tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)     AS a FROM transfers WHERE user_id=$1 GROUP BY to_wallet_id),
     tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers WHERE user_id=$1 GROUP BY from_wallet_id),
     bal AS (
       SELECT w.name, w.type,
         -- crypto は最新スナップショット（評価額の手入力）を「正」とする（ADR-043）
         (CASE WHEN w.type='crypto' AND cs.actual_balance IS NOT NULL THEN cs.actual_balance
               ELSE w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0) END)::int AS balance,
         w.id
       FROM wallets w
       LEFT JOIN legs   ON legs.wallet_id = w.id
       LEFT JOIN tr_in  ON tr_in.wid  = w.id
       LEFT JOIN tr_out ON tr_out.wid = w.id
       LEFT JOIN LATERAL (
         SELECT actual_balance FROM balance_snapshots s
         WHERE s.wallet_id = w.id ORDER BY as_of_date DESC LIMIT 1
       ) cs ON w.type='crypto'
       WHERE w.user_id = $1
     )
     SELECT name, type, balance FROM bal
     WHERE balance <> 0
     ORDER BY type, id`,
    [await uid()]
  );
  return rows;
}

export type Assets = { total_assets: number; card_unpaid: number; net_assets: number };

export async function getAssets(): Promise<Assets> {
  const { rows } = await pool.query(
    `WITH legs AS (
       SELECT tl.wallet_id,
         SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
       FROM transaction_legs tl JOIN transactions t ON t.id = tl.transaction_id
       WHERE t.user_id = $1 GROUP BY tl.wallet_id
     ),
     tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)     AS a FROM transfers WHERE user_id=$1 GROUP BY to_wallet_id),
     tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers WHERE user_id=$1 GROUP BY from_wallet_id),
     bal AS (
       SELECT w.type, w.include_in_assets,
         -- crypto は最新スナップショット（評価額）を「正」とする（ADR-043）
         CASE WHEN w.type='crypto' AND cs.actual_balance IS NOT NULL THEN cs.actual_balance
              ELSE w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0) END AS balance
       FROM wallets w
       LEFT JOIN legs ON legs.wallet_id=w.id
       LEFT JOIN tr_in ON tr_in.wid=w.id
       LEFT JOIN tr_out ON tr_out.wid=w.id
       LEFT JOIN LATERAL (
         SELECT actual_balance FROM balance_snapshots s
         WHERE s.wallet_id = w.id ORDER BY as_of_date DESC LIMIT 1
       ) cs ON w.type='crypto'
       WHERE w.user_id=$1
     )
     SELECT
       COALESCE(SUM(balance) FILTER (WHERE type<>'credit_card' AND include_in_assets),0)::int AS total_assets,
       COALESCE(-SUM(balance) FILTER (WHERE type='credit_card'),0)::int                       AS card_unpaid,
       COALESCE(SUM(balance),0)::int                                                          AS net_assets
     FROM bal`,
    [await uid()]
  );
  return rows[0];
}

export type InputCategory = { id: number; name: string; pl_type: string };

// 入力可能（葉）カテゴリ一覧。入力フォームのプルダウン用。
export async function getInputCategories(): Promise<InputCategory[]> {
  const { rows } = await pool.query(
    `SELECT id, name, pl_type FROM categories
     WHERE user_id=$1 AND is_input_allowed AND is_active
     ORDER BY pl_type, display_order, id`,
    [await uid()]
  );
  return rows;
}

export type CategoryManageRow = {
  id: number;
  parent_id: number | null;
  name: string;
  pl_type: string;
  is_input_allowed: boolean;
  is_active: boolean;
  parent_name: string | null;
  child_count: number;
  tx_count: number; // この費目を使う取引数（削除可否の判定）
};

// カテゴリ管理画面用（ツリー＋使用数 / ADR-050）
export async function getCategoriesForManagement(): Promise<CategoryManageRow[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT c.id, c.parent_id, c.name, c.pl_type, c.is_input_allowed, c.is_active,
            p.name AS parent_name,
            (SELECT COUNT(*) FROM categories ch WHERE ch.parent_id=c.id) AS child_count,
            (SELECT COUNT(*) FROM transactions t WHERE t.category_id=c.id) AS tx_count
     FROM categories c
     LEFT JOIN categories p ON p.id=c.parent_id
     WHERE c.user_id=$1
     ORDER BY c.pl_type, COALESCE(c.parent_id, c.id), c.parent_id NULLS FIRST, c.display_order, c.id`,
    [await uid()]
  );
  return rows.map((r) => ({ ...r, child_count: Number(r.child_count), tx_count: Number(r.tx_count) }));
}

export type WalletOption = { id: number; name: string; type: string };

// ウォレット一覧。決済手段プルダウン用。
export async function getWalletOptions(): Promise<WalletOption[]> {
  const { rows } = await pool.query(
    `SELECT id, name, type FROM wallets
     WHERE user_id=$1 AND is_active
     ORDER BY type, display_order, id`,
    [await uid()]
  );
  return rows;
}

export type WalletManageRow = {
  id: number;
  name: string;
  type: string;
  initial_balance: number;
  include_in_assets: boolean;
  is_balance_tracked: boolean;
  is_active: boolean;
  closing_day: number | null;
  closing_eom: boolean;
  payment_day: number | null;
  payment_eom: boolean;
  payment_month_offset: number;
  settlement_wallet_id: number | null;
  settlement_name: string | null;
  balance: number; // 現在残高（cryptoは最新スナップショット）
  in_use: boolean; // 取引等から参照されているか（削除=無効化になる）
};

// ウォレット管理画面用（全フィールド＋現在残高＋参照有無 / ADR-048）
export async function getWalletsForManagement(): Promise<WalletManageRow[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `WITH legs AS (
       SELECT tl.wallet_id, SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d,
              COUNT(*) AS n
       FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
       WHERE t.user_id=$1 GROUP BY tl.wallet_id
     ),
     tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)     AS a, COUNT(*) AS n FROM transfers WHERE user_id=$1 GROUP BY to_wallet_id),
     tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a, COUNT(*) AS n FROM transfers WHERE user_id=$1 GROUP BY from_wallet_id)
     SELECT w.id, w.name, w.type, w.initial_balance, w.include_in_assets, w.is_balance_tracked, w.is_active,
            w.closing_day, w.closing_eom, w.payment_day, w.payment_eom, w.payment_month_offset,
            w.settlement_wallet_id, sw.name AS settlement_name,
            (CASE WHEN w.type='crypto' AND cs.actual_balance IS NOT NULL THEN cs.actual_balance
                  ELSE w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0) END)::int AS balance,
            (COALESCE(legs.n,0) + COALESCE(tr_in.n,0) + COALESCE(tr_out.n,0)
             + (SELECT COUNT(*) FROM recurring_rules r WHERE r.settlement_wallet_id=w.id)
             + (SELECT COUNT(*) FROM card_statements cst WHERE cst.wallet_id=w.id)
             + (SELECT COUNT(*) FROM wallets w2 WHERE w2.settlement_wallet_id=w.id)) > 0 AS in_use
     FROM wallets w
     LEFT JOIN wallets sw ON sw.id = w.settlement_wallet_id
     LEFT JOIN legs   ON legs.wallet_id = w.id
     LEFT JOIN tr_in  ON tr_in.wid  = w.id
     LEFT JOIN tr_out ON tr_out.wid = w.id
     LEFT JOIN LATERAL (
       SELECT actual_balance FROM balance_snapshots s WHERE s.wallet_id=w.id ORDER BY as_of_date DESC LIMIT 1
     ) cs ON w.type='crypto'
     WHERE w.user_id=$1
     ORDER BY w.is_active DESC, w.display_order, w.id`,
    [await uid()]
  );
  return rows;
}

// ---- DBインスペクター用（学習目的：テーブルの中身をそのまま見る） ----
export async function listTables(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'
     ORDER BY table_name`
  );
  return rows.map((r) => r.table_name as string);
}

export type TableDump = {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  shown: number;
};

export async function getTableDump(table: string): Promise<TableDump> {
  // SQLインジェクション対策：英小文字とアンダースコアのみ許可（テーブル名は信頼値だが念のため）
  if (!/^[a-z_]+$/.test(table)) throw new Error("invalid table name");
  const res = await pool.query(`SELECT * FROM ${table} ORDER BY 1 LIMIT 200`);
  const cnt = await pool.query(`SELECT count(*)::int AS c FROM ${table}`);
  return {
    columns: res.fields.map((f) => f.name),
    rows: res.rows,
    total: cnt.rows[0].c,
    shown: res.rowCount ?? res.rows.length,
  };
}

// ---- ビジョン/目標（自由記述の箱） ----
export async function getVisionNote(): Promise<string> {
  const { rows } = await pool.query(`SELECT content FROM vision_notes WHERE user_id=$1`, [await uid()]);
  return rows[0]?.content ?? "";
}

// ---- 残高リコンサイル（実残高との照合 / ADR-027） ----
export type ReconcileRow = {
  id: number;
  name: string;
  type: string;
  computed: number; // 自動算出残高
  actual: number | null; // 直近に記録した実残高
  as_of: string | null; // その基準日
};

export async function getReconcileData(): Promise<ReconcileRow[]> {
  const { rows } = await pool.query(
    `WITH legs AS (
       SELECT tl.wallet_id, SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
       FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
       WHERE t.user_id=$1 GROUP BY tl.wallet_id
     ),
     tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)     AS a FROM transfers WHERE user_id=$1 GROUP BY to_wallet_id),
     tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers WHERE user_id=$1 GROUP BY from_wallet_id),
     bal AS (
       SELECT w.id, w.name, w.type, w.is_balance_tracked,
         (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0))::int AS balance
       FROM wallets w
       LEFT JOIN legs ON legs.wallet_id=w.id LEFT JOIN tr_in ON tr_in.wid=w.id LEFT JOIN tr_out ON tr_out.wid=w.id
       WHERE w.user_id=$1
     )
     SELECT b.id, b.name, b.type, b.balance AS computed,
            s.actual_balance AS actual, to_char(s.as_of_date,'YYYY-MM-DD') AS as_of
     FROM bal b
     LEFT JOIN LATERAL (
       SELECT actual_balance, as_of_date FROM balance_snapshots s
       WHERE s.wallet_id=b.id ORDER BY as_of_date DESC LIMIT 1
     ) s ON true
     WHERE b.is_balance_tracked
     ORDER BY b.type, b.id`,
    [await uid()]
  );
  return rows;
}

// ---- FY（会計年度）年次ビュー（ADR-007/017） ----
export async function getUserFyStartMonth(): Promise<number> {
  const { rows } = await pool.query(`SELECT fiscal_year_start_month FROM users WHERE id=$1`, [await uid()]);
  return rows[0]?.fiscal_year_start_month ?? 4;
}

export type FyMonthPL = { month: string; income: number; fixed: number; variable: number; surplus: number };

// FY開始月(月初日)から12ヶ月分の月次PL。固定費は実績(fixed_cost取引)ベース。
export async function getFiscalYearPL(startPeriod: string): Promise<FyMonthPL[]> {
  const { rows } = await pool.query(
    `WITH months AS (
       SELECT generate_series($2::date, ($2::date + interval '11 months'), interval '1 month')::date AS m
     ),
     agg AS (
       SELECT date_trunc('month', t.accrual_date)::date AS mo, c.pl_type, t.type, SUM(t.amount) AS amt
       FROM transactions t JOIN categories c ON c.id=t.category_id
       WHERE t.user_id=$1 AND t.accrual_date >= $2::date AND t.accrual_date < ($2::date + interval '12 months')
       GROUP BY 1,2,3
     )
     SELECT to_char(mo.m,'YYYY-MM') AS month,
       COALESCE(SUM(amt) FILTER (WHERE type='income'  AND pl_type='income'),0)::int        AS income,
       COALESCE(SUM(amt) FILTER (WHERE type='expense' AND pl_type='fixed_cost'),0)::int    AS fixed,
       COALESCE(SUM(amt) FILTER (WHERE type='expense' AND pl_type='variable_cost'),0)::int AS variable
     FROM months mo LEFT JOIN agg ON agg.mo = mo.m
     GROUP BY mo.m ORDER BY mo.m`,
    [await uid(), startPeriod]
  );
  return rows.map((r) => ({ ...r, surplus: r.income - r.fixed - r.variable }));
}

export type FyTotal = { income: number; fixed: number; variable: number; surplus: number };

// FY（開始月初日から12ヶ月）の年計のみを取得（複数FY比較用・軽量）。
export async function getFiscalYearTotal(startPeriod: string): Promise<FyTotal> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'  AND pl_type='income'),0)::int        AS income,
            COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type='fixed_cost'),0)::int    AS fixed,
            COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type='variable_cost'),0)::int AS variable
     FROM transactions t JOIN categories c ON c.id=t.category_id
     WHERE t.user_id=$1 AND t.accrual_date >= $2::date AND t.accrual_date < ($2::date + interval '12 months')`,
    [await uid(), startPeriod]
  );
  const r = rows[0];
  return { ...r, surplus: r.income - r.fixed - r.variable };
}

// ---- クレカ請求サイクル（ADR-023） ----
export type CardLeg = {
  card_id: number;
  card_name: string;
  closing_day: number | null;
  closing_eom: boolean;
  payment_day: number | null;
  payment_eom: boolean;
  payment_month_offset: number;
  settlement_name: string | null;
  tx_id: number;
  date: string; // 'YYYY-MM-DD'
  amount: number;
  category: string;
  memo: string | null;
};

// クレカ消込済みの締めサイクル（memoに 'クレカ消込:YYYY-MM-DD締め' を埋めている）。
export async function getCardSettlements(): Promise<{ card_id: number; close_key: string }[]> {
  const { rows } = await pool.query(
    `SELECT to_wallet_id AS card_id, memo FROM transfers
     WHERE user_id=$1 AND kind='card_settlement' AND memo LIKE 'クレカ消込:%締め'`,
    [await uid()]
  );
  return rows
    .map((r) => {
      const m = (r.memo as string).match(/クレカ消込:(\d{4}-\d{2}-\d{2})締め/);
      return m ? { card_id: r.card_id as number, close_key: m[1] } : null;
    })
    .filter((x): x is { card_id: number; close_key: string } => x !== null);
}

// クレカで支払った取引脚（カード設定つき）。請求サイクルの判定はアプリ側で行う（ADR-023）。
export async function getCardLegs(): Promise<CardLeg[]> {
  const { rows } = await pool.query(
    `SELECT w.id AS card_id, w.name AS card_name,
            w.closing_day, w.closing_eom, w.payment_day, w.payment_eom, w.payment_month_offset,
            sw.name AS settlement_name,
            t.id AS tx_id, to_char(t.accrual_date,'YYYY-MM-DD') AS date, tl.amount,
            c.name AS category, t.memo
     FROM transaction_legs tl
     JOIN wallets w ON w.id = tl.wallet_id AND w.type='credit_card'
     JOIN transactions t ON t.id = tl.transaction_id
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN wallets sw ON sw.id = w.settlement_wallet_id
     WHERE w.user_id=$1 AND t.type='expense'
     ORDER BY w.id, t.accrual_date`,
    [await uid()]
  );
  return rows;
}

// ---- 予実管理（ADR-016/020） ----
export type BudgetVsActual = {
  target_income: number;
  target_expense: number;
  target_total_assets: number;
  actual_income: number;
  actual_expense: number;
  closed: boolean; // 月の確定（黒塗り）
};

// 指定月の総資産目標（無ければ0）。
export async function getAssetTarget(period: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT amount FROM targets WHERE user_id=$1 AND period=$2 AND metric='total_assets'`,
    [await uid(), period]
  );
  return rows[0]?.amount ?? 0;
}

export async function getBudgetVsActual(period: string): Promise<BudgetVsActual> {
  const t = await pool.query(`SELECT metric, amount FROM targets WHERE user_id=$1 AND period=$2`, [
    await uid(),
    period,
  ]);
  const tg: Record<string, number> = {};
  t.rows.forEach((r) => (tg[r.metric] = r.amount));

  const a = await pool.query(
    `WITH x AS (
       SELECT t.type, c.pl_type, t.amount
       FROM transactions t JOIN categories c ON c.id=t.category_id
       WHERE t.user_id=$1 AND t.accrual_date>=$2::date AND t.accrual_date<($2::date + interval '1 month')
     )
     SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'  AND pl_type='income'),0)::int AS inc,
            COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type IN ('fixed_cost','variable_cost')),0)::int AS exp
     FROM x`,
    [await uid(), period]
  );

  const c = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE is_closed)::int AS closed_n
     FROM monthly_closings
     WHERE user_id=$1 AND period=$2 AND section IN ('income','fixed_cost','variable_cost')`,
    [await uid(), period]
  );

  return {
    target_income: tg["income"] ?? 0,
    target_expense: tg["expense"] ?? 0,
    target_total_assets: tg["total_assets"] ?? 0,
    actual_income: a.rows[0].inc,
    actual_expense: a.rows[0].exp,
    closed: c.rows[0].closed_n >= 3,
  };
}

// ---- 資産ダッシュボード（ADR-027） ----
export type AssetTrendPoint = { month: string; total_assets: number; net_assets: number };

// 月末時点の総資産・純資産の推移（最低6ヶ月）。取引・振替の累計から算出。
export async function getAssetTrend(): Promise<AssetTrendPoint[]> {
  const { rows } = await pool.query(
    `WITH bounds AS (
       SELECT LEAST(
                date_trunc('month', COALESCE((SELECT MIN(accrual_date) FROM transactions WHERE user_id=$1), CURRENT_DATE))::date,
                (date_trunc('month', CURRENT_DATE) - interval '5 months')::date
              ) AS start_m,
              date_trunc('month', CURRENT_DATE)::date AS end_m
     ),
     months AS (SELECT generate_series((SELECT start_m FROM bounds),(SELECT end_m FROM bounds), interval '1 month')::date AS m),
     aw AS (SELECT id FROM wallets WHERE user_id=$1 AND include_in_assets AND type NOT IN ('credit_card','crypto')),
     cw AS (SELECT id FROM wallets WHERE user_id=$1 AND type='credit_card'),
     -- crypto は各月末時点の最新スナップショット（評価額）で評価（ADR-043）
     crw AS (SELECT id FROM wallets WHERE user_id=$1 AND include_in_assets AND type='crypto'),
     init AS (SELECT COALESCE(SUM(initial_balance),0) AS v FROM wallets WHERE user_id=$1 AND include_in_assets AND type NOT IN ('credit_card','crypto'))
     SELECT to_char(mo.m,'YYYY-MM') AS month,
       ((SELECT v FROM init)
        + COALESCE((SELECT SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END)
                    FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
                    WHERE t.user_id=$1 AND tl.wallet_id IN (SELECT id FROM aw) AND t.accrual_date < (mo.m + interval '1 month')),0)
        + COALESCE((SELECT SUM(amount)     FROM transfers WHERE user_id=$1 AND to_wallet_id   IN (SELECT id FROM aw) AND transfer_date < (mo.m + interval '1 month')),0)
        - COALESCE((SELECT SUM(amount+fee) FROM transfers WHERE user_id=$1 AND from_wallet_id IN (SELECT id FROM aw) AND transfer_date < (mo.m + interval '1 month')),0)
        + COALESCE((SELECT SUM(cv.v) FROM crw c
                    CROSS JOIN LATERAL (
                      SELECT s.actual_balance AS v FROM balance_snapshots s
                      WHERE s.wallet_id = c.id AND s.as_of_date < (mo.m + interval '1 month')
                      ORDER BY s.as_of_date DESC LIMIT 1
                    ) cv),0)
       )::int AS total_assets,
       ( COALESCE((SELECT SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END)
                    FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
                    WHERE t.user_id=$1 AND tl.wallet_id IN (SELECT id FROM cw) AND t.accrual_date < (mo.m + interval '1 month')),0)
        + COALESCE((SELECT SUM(amount)     FROM transfers WHERE user_id=$1 AND to_wallet_id   IN (SELECT id FROM cw) AND transfer_date < (mo.m + interval '1 month')),0)
        - COALESCE((SELECT SUM(amount+fee) FROM transfers WHERE user_id=$1 AND from_wallet_id IN (SELECT id FROM cw) AND transfer_date < (mo.m + interval '1 month')),0)
       )::int AS card_balance
     FROM months mo ORDER BY mo.m`,
    [await uid()]
  );
  return rows.map((r) => ({
    month: r.month,
    total_assets: r.total_assets,
    net_assets: r.total_assets + r.card_balance, // card_balanceは負（未払い）
  }));
}

export type AssetTypeTotal = { type: string; total: number };

// 現在の資産内訳（種別別・資産系のみ）。
export async function getAssetBreakdown(): Promise<AssetTypeTotal[]> {
  const { rows } = await pool.query(
    `WITH legs AS (
       SELECT tl.wallet_id, SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
       FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
       WHERE t.user_id=$1 GROUP BY tl.wallet_id
     ),
     tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)     AS a FROM transfers WHERE user_id=$1 GROUP BY to_wallet_id),
     tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers WHERE user_id=$1 GROUP BY from_wallet_id),
     bal AS (
       SELECT w.type, w.include_in_assets,
         -- crypto は最新スナップショット（評価額）を「正」とする（ADR-043）
         CASE WHEN w.type='crypto' AND cs.actual_balance IS NOT NULL THEN cs.actual_balance
              ELSE w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0) END AS balance
       FROM wallets w
       LEFT JOIN legs ON legs.wallet_id=w.id LEFT JOIN tr_in ON tr_in.wid=w.id LEFT JOIN tr_out ON tr_out.wid=w.id
       LEFT JOIN LATERAL (
         SELECT actual_balance FROM balance_snapshots s
         WHERE s.wallet_id = w.id ORDER BY as_of_date DESC LIMIT 1
       ) cs ON w.type='crypto'
       WHERE w.user_id=$1
     )
     SELECT type, SUM(balance)::int AS total FROM bal
     WHERE include_in_assets AND type<>'credit_card'
     GROUP BY type HAVING SUM(balance) <> 0 ORDER BY total DESC`,
    [await uid()]
  );
  return rows;
}

export type CryptoWallet = { id: number; name: string; value: number | null; as_of: string | null };

// 暗号資産ウォレット一覧＋最新評価額（ADR-043）。
export async function getCryptoWallets(): Promise<CryptoWallet[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT w.id, w.name, s.actual_balance AS value, to_char(s.as_of_date,'YYYY-MM-DD') AS as_of
     FROM wallets w
     LEFT JOIN LATERAL (
       SELECT actual_balance, as_of_date FROM balance_snapshots s
       WHERE s.wallet_id = w.id ORDER BY as_of_date DESC LIMIT 1
     ) s ON true
     WHERE w.user_id=$1 AND w.type='crypto' AND w.is_active
     ORDER BY w.display_order, w.id`,
    [await uid()]
  );
  return rows;
}

export type MonthTotal = { month: string; total: number };

// 配当（投資収益(配当)）の月次推移。
export async function getDividendTrend(): Promise<MonthTotal[]> {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', t.accrual_date),'YYYY-MM') AS month, SUM(t.amount)::int AS total
     FROM transactions t JOIN categories c ON c.id=t.category_id
     WHERE t.user_id=$1 AND t.type='income' AND c.name='投資収益(配当)'
     GROUP BY 1 ORDER BY 1`,
    [await uid()]
  );
  return rows;
}

export type CategoryTotal = { id: number; name: string; total: number };

// 変動費グループ（ルート）ごとの配下合計（再帰ロールアップ）。指定月のみ集計。
export async function getVariableGroups(period = "2026-06-01"): Promise<CategoryTotal[]> {
  const { rows } = await pool.query(
    `WITH RECURSIVE
       leaf AS (
         SELECT category_id, SUM(amount) AS amt
         FROM transactions
         WHERE user_id=$1 AND type='expense'
           AND accrual_date >= $2::date
           AND accrual_date <  ($2::date + interval '1 month')
         GROUP BY category_id
       ),
       subtree AS (
         SELECT id AS root_id, id AS node_id FROM categories WHERE user_id=$1
         UNION ALL
         SELECT s.root_id, c.id FROM subtree s JOIN categories c ON c.parent_id = s.node_id
       )
     SELECT c.id, c.name, COALESCE(SUM(l.amt),0)::int AS total
     FROM categories c
     JOIN subtree s ON s.root_id = c.id
     LEFT JOIN leaf l ON l.category_id = s.node_id
     WHERE c.user_id=$1 AND c.pl_type='variable_cost' AND c.parent_id IS NULL
     GROUP BY c.id, c.name
     ORDER BY c.display_order, c.id`,
    [await uid(), period]
  );
  return rows;
}

// ---- 月次ビュー（現運用の月次タブ再現 / ADR-047） ----
export type MonthlyIncomeRow = { id: number; name: string; pl_type: string; total: number };

// 収入セクションの行：収入カテゴリ（葉）＋PL対象外のうち収入系（経費精算・借入金）。
// シートの月次収入タブの行構成を再現する。
export async function getMonthlyIncomeRows(period: string): Promise<MonthlyIncomeRow[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.pl_type,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='income'),0)::int AS total
     FROM categories c
     LEFT JOIN transactions t
       ON t.category_id = c.id AND t.user_id = $1
      AND t.accrual_date >= $2::date AND t.accrual_date < ($2::date + interval '1 month')
     WHERE c.user_id = $1 AND c.is_active
       AND NOT EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = c.id)
       AND (c.pl_type = 'income' OR (c.pl_type = 'excluded' AND c.name IN ('経費精算','借入金')))
     GROUP BY c.id, c.name, c.pl_type
     ORDER BY (c.pl_type = 'income') DESC, c.display_order, c.id`,
    [await uid(), period]
  );
  return rows;
}

export type VariableLeafRow = { id: number; name: string; group_name: string; total: number };

// 変動費の葉カテゴリ×当月合計（所属グループ名つき）。シートの月次支出タブの変動費内訳を再現。
// 入力不可の葉（取込用など）は金額がある月だけ表示する。
export async function getVariableLeaves(period: string): Promise<VariableLeafRow[]> {
  const { rows } = await pool.query(
    `WITH RECURSIVE up AS (
       SELECT id, id AS leaf_id, parent_id
       FROM categories
       WHERE user_id = $1 AND pl_type = 'variable_cost'
         AND NOT EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = categories.id)
       UNION ALL
       SELECT c.id, up.leaf_id, c.parent_id FROM categories c JOIN up ON c.id = up.parent_id
     ),
     root AS (SELECT leaf_id, id AS root_id FROM up WHERE parent_id IS NULL),
     sums AS (
       SELECT category_id, SUM(amount)::int AS amt FROM transactions
       WHERE user_id = $1 AND type = 'expense'
         AND accrual_date >= $2::date AND accrual_date < ($2::date + interval '1 month')
       GROUP BY category_id
     )
     SELECT l.id, l.name, rc.name AS group_name, COALESCE(s.amt,0) AS total
     FROM categories l
     JOIN root r ON r.leaf_id = l.id
     JOIN categories rc ON rc.id = r.root_id
     LEFT JOIN sums s ON s.category_id = l.id
     WHERE l.user_id = $1 AND l.is_active
       AND (l.is_input_allowed OR COALESCE(s.amt,0) <> 0)
     ORDER BY rc.display_order, rc.id, l.display_order, l.id`,
    [await uid(), period]
  );
  return rows;
}

// 月の確定状態（黒塗り / ADR-020）
export async function getMonthClosed(period: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT COALESCE(bool_or(is_closed), false) AS closed
     FROM monthly_closings WHERE user_id=$1 AND period=$2::date`,
    [await uid(), period]
  );
  return rows[0]?.closed ?? false;
}

export type FixedCostItem = {
  id: number;
  name: string;
  plan: number; // 予定額（マスタ recurring_rules）
  actual: number | null; // 実額（当月の取引。無ければ null）
  effective: number; // COALESCE(実額, 予定額)＝PL計上に使う額
  is_actual: boolean; // 実額が入っているか（予定/実績バッジ用）
  wallet_name: string | null; // 引落先ウォレット名
};

// 固定費の予実突合（ADR-030）。指定月にアクティブな固定費マスタを「予定額」とし、
// 当月の fixed_cost 取引（category_id で突合）を「実額」として並べる。予定は取引化しない。
// 年額サブスク（billing_cycle='yearly'）は月次PLに出さない（ADR-035）。
export async function getFixedCostPlanVsActual(
  period = "2026-06-01"
): Promise<FixedCostItem[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `WITH active_rules AS (
       SELECT r.id, r.name, r.category_id, r.amount AS plan, w.name AS wallet_name
       FROM recurring_rules r
       LEFT JOIN wallets w ON w.id = r.settlement_wallet_id
       WHERE r.user_id = $1 AND r.is_active
         AND r.billing_cycle = 'monthly'
         AND r.start_month <= $2::date
         AND (r.end_month IS NULL OR r.end_month > $2::date)
     ),
     actual AS (
       SELECT category_id, SUM(amount)::int AS act
       FROM transactions
       WHERE user_id = $1 AND type='expense'
         AND accrual_date >= $2::date
         AND accrual_date <  ($2::date + interval '1 month')
       GROUP BY category_id
     ),
     -- 過去月は「実績のみ」（予定額で埋めない）。実額が無い＝その月は発生しなかった＝¥0。
     -- 当月・未来月だけ予定額でフォールバック（現運用の"定額仮置き"を再現／ADR-030・047）。
     is_past AS (SELECT ($2::date < date_trunc('month', CURRENT_DATE)) AS v)
     SELECT ar.id, ar.name, ar.plan, ar.wallet_name,
            a.act                                                                    AS actual,
            (CASE WHEN (SELECT v FROM is_past) THEN COALESCE(a.act, 0)
                  ELSE COALESCE(a.act, ar.plan) END)::int                            AS effective,
            (CASE WHEN (SELECT v FROM is_past) THEN true ELSE (a.act IS NOT NULL) END) AS is_actual
     FROM active_rules ar
     LEFT JOIN actual a ON a.category_id = ar.category_id
     ORDER BY ar.plan DESC, ar.id`,
    [await uid(), period]
  );
  return rows;
}

export type TxRow = {
  id: number;
  date: string; // 'YYYY-MM-DD'
  category: string;
  pl_type: string;
  type: string; // 'expense' | 'income'
  amount: number;
  memo: string | null;
  mood: number | null; // 気分 1-5（ADR-036）
  wallets: string | null; // 支払い脚のウォレット名（分割は ' + ' 連結）
};

export type TxFilter = {
  type?: "expense" | "income"; // 種別
  categoryId?: number; // カテゴリ
  walletId?: number; // 決済ウォレット（脚に含まれる取引）
};

// 指定月の取引一覧（カテゴリ名・決済ウォレット名つき）。発生日の新しい順。
// filter で 種別/カテゴリ/決済手段 の絞り込みができる（③）。
export async function getMonthTransactions(
  period = "2026-06-01",
  filter: TxFilter = {}
): Promise<TxRow[]> {
  const cond: string[] = [];
  const params: unknown[] = [await uid(), period];
  if (filter.type) {
    params.push(filter.type);
    cond.push(`AND t.type = $${params.length}`);
  }
  if (filter.categoryId) {
    params.push(filter.categoryId);
    cond.push(`AND t.category_id = $${params.length}`);
  }
  if (filter.walletId) {
    params.push(filter.walletId);
    cond.push(
      `AND EXISTS (SELECT 1 FROM transaction_legs x WHERE x.transaction_id = t.id AND x.wallet_id = $${params.length})`
    );
  }
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT t.id,
            to_char(t.accrual_date, 'YYYY-MM-DD') AS date,
            c.name AS category, c.pl_type, t.type, t.amount, t.memo, t.mood,
            string_agg(w.name, ' + ' ORDER BY tl.id) AS wallets
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN transaction_legs tl ON tl.transaction_id = t.id
     LEFT JOIN wallets w ON w.id = tl.wallet_id
     WHERE t.user_id = $1
       AND t.accrual_date >= $2::date
       AND t.accrual_date <  ($2::date + interval '1 month')
       ${cond.join("\n       ")}
     GROUP BY t.id, c.name, c.pl_type, t.type, t.amount, t.memo, t.mood, t.accrual_date
     ORDER BY t.accrual_date DESC, t.id DESC`,
    params
  );
  return rows;
}

// ---- カレンダー（日次入力 / ADR-034） ----
export type DailyTotal = { date: string; expense: number; income: number };

// 指定月の日毎の支出・収入合計（カレンダーのセル表示用）。
export async function getDailyTotals(period: string): Promise<DailyTotal[]> {
  const { rows } = await pool.query(
    `SELECT to_char(t.accrual_date,'YYYY-MM-DD') AS date,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND c.pl_type IN ('fixed_cost','variable_cost')),0)::int AS expense,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='income'  AND c.pl_type='income'),0)::int AS income
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1
       AND t.accrual_date >= $2::date
       AND t.accrual_date <  ($2::date + interval '1 month')
     GROUP BY t.accrual_date
     ORDER BY t.accrual_date`,
    [await uid(), period]
  );
  return rows;
}

// 指定日の取引一覧（カレンダーの選択日詳細用）。
export async function getDayTransactions(date: string): Promise<TxRow[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT t.id,
            to_char(t.accrual_date, 'YYYY-MM-DD') AS date,
            c.name AS category, c.pl_type, t.type, t.amount, t.memo, t.mood,
            string_agg(w.name, ' + ' ORDER BY tl.id) AS wallets
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN transaction_legs tl ON tl.transaction_id = t.id
     LEFT JOIN wallets w ON w.id = tl.wallet_id
     WHERE t.user_id = $1 AND t.accrual_date = $2::date
     GROUP BY t.id, c.name, c.pl_type, t.type, t.amount, t.memo, t.mood, t.accrual_date
     ORDER BY t.id DESC`,
    [await uid(), date]
  );
  return rows;
}

// ---- 週次進捗（現運用「(週次)進捗」タブの再現 / ADR-036） ----
export type WeeklyRow = {
  week_start: string; // 'YYYY-MM-DD'（月曜）
  week_end: string; // 'YYYY-MM-DD'（日曜）
  total: number; // 変動費合計
  groups: Record<string, number>; // 変動費ルートグループ名 → 配下合計
};

// 直近 n 週の変動費を週×ルートグループでロールアップ（月曜始まり）。
export async function getWeeklyProgress(weeks = 12): Promise<{ groups: string[]; rows: WeeklyRow[] }> {
  const { rows } = await pool.query(
    `WITH RECURSIVE
       subtree AS (
         SELECT id AS root_id, id AS node_id FROM categories WHERE user_id=$1
         UNION ALL
         SELECT s.root_id, c.id FROM subtree s JOIN categories c ON c.parent_id = s.node_id
       ),
       roots AS (
         SELECT id, name, display_order FROM categories
         WHERE user_id=$1 AND pl_type='variable_cost' AND parent_id IS NULL
       ),
       tx AS (
         SELECT date_trunc('week', accrual_date)::date AS wk, category_id, amount
         FROM transactions
         WHERE user_id=$1 AND type='expense'
           AND accrual_date >= date_trunc('week', CURRENT_DATE) - ($2 || ' weeks')::interval
       )
     SELECT to_char(t.wk,'YYYY-MM-DD') AS week_start, r.name AS group_name,
            SUM(t.amount)::int AS total
     FROM tx t
     JOIN subtree s ON s.node_id = t.category_id
     JOIN roots r ON r.id = s.root_id
     GROUP BY t.wk, r.name, r.display_order
     ORDER BY t.wk DESC, r.display_order`,
    [await uid(), weeks]
  );
  const groupNames: string[] = [];
  const byWeek = new Map<string, WeeklyRow>();
  for (const r of rows) {
    if (!groupNames.includes(r.group_name)) groupNames.push(r.group_name);
    let w = byWeek.get(r.week_start);
    if (!w) {
      const end = new Date(r.week_start + "T00:00:00");
      end.setDate(end.getDate() + 6);
      const p = (n: number) => String(n).padStart(2, "0");
      w = {
        week_start: r.week_start,
        week_end: `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}`,
        total: 0,
        groups: {},
      };
      byWeek.set(r.week_start, w);
    }
    w.groups[r.group_name] = r.total;
    w.total += r.total;
  }
  return { groups: groupNames, rows: [...byWeek.values()] };
}

// ---- 年間の予実対比（現運用サマリの「(FY)年間予算達成」再現 / ADR-036） ----
export type FyTargetRow = { month: string; income: number; expense: number };

// FY12ヶ月分の月次目標（targets）。/year の予実対比テーブル用。
export async function getFyTargets(startPeriod: string): Promise<FyTargetRow[]> {
  const { rows } = await pool.query(
    `WITH months AS (
       SELECT generate_series($2::date, ($2::date + interval '11 months'), interval '1 month')::date AS m
     )
     SELECT to_char(mo.m,'YYYY-MM') AS month,
            COALESCE(MAX(t.amount) FILTER (WHERE t.metric='income'),0)::int  AS income,
            COALESCE(MAX(t.amount) FILTER (WHERE t.metric='expense'),0)::int AS expense
     FROM months mo
     LEFT JOIN targets t ON t.user_id=$1 AND t.period=mo.m AND t.metric IN ('income','expense')
     GROUP BY mo.m ORDER BY mo.m`,
    [await uid(), startPeriod]
  );
  return rows;
}

export type TxEdit = {
  id: number;
  type: "expense" | "income";
  amount: number;
  category_id: number;
  date: string; // 'YYYY-MM-DD'
  memo: string | null;
  wallet_id: number | null; // 先頭の脚（編集は単一脚に集約）
  leg_count: number; // 2以上なら分割払い（編集で単一脚に集約される旨を警告）
};

// 編集用に取引1件を取得（先頭の支払い脚のウォレットを既定にする）。
export async function getTransactionForEdit(id: number): Promise<TxEdit | null> {
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.amount, t.category_id,
            to_char(t.accrual_date, 'YYYY-MM-DD') AS date, t.memo,
            (SELECT wallet_id FROM transaction_legs WHERE transaction_id = t.id ORDER BY id LIMIT 1) AS wallet_id,
            (SELECT count(*)::int FROM transaction_legs WHERE transaction_id = t.id) AS leg_count
     FROM transactions t
     WHERE t.id = $1 AND t.user_id = $2`,
    [id, await uid()]
  );
  return rows[0] ?? null;
}

// ---- 固定費マスタ（recurring_rules）の管理 ----
export type RecurringRule = {
  id: number;
  name: string;
  amount: number;
  category_id: number;
  category_name: string;
  settlement_wallet_id: number;
  wallet_name: string | null;
  start_month: string; // 'YYYY-MM'
  end_month: string | null; // 'YYYY-MM' or null=継続中
  billing_day: number | null;
  billing_cycle: "monthly" | "yearly"; // 月額/年額（ADR-035）
  payment_month: number | null; // 年額の支払月（1-12）
  is_active: boolean;
};

// 固定費マスタ一覧（継続中→終了済みの順）。
export async function getRecurringRules(): Promise<RecurringRule[]> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.amount, r.category_id, c.name AS category_name,
            r.settlement_wallet_id, w.name AS wallet_name,
            to_char(r.start_month, 'YYYY-MM') AS start_month,
            to_char(r.end_month,   'YYYY-MM') AS end_month,
            r.billing_day, r.billing_cycle, r.payment_month, r.is_active
     FROM recurring_rules r
     JOIN categories c ON c.id = r.category_id
     LEFT JOIN wallets w ON w.id = r.settlement_wallet_id
     WHERE r.user_id = $1
     ORDER BY (r.end_month IS NOT NULL), r.amount DESC, r.id`,
    [await uid()]
  );
  return rows;
}

export async function getRecurringRuleForEdit(id: number): Promise<RecurringRule | null> {
  await ensureMigrated();
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.amount, r.category_id, c.name AS category_name,
            r.settlement_wallet_id, w.name AS wallet_name,
            to_char(r.start_month, 'YYYY-MM') AS start_month,
            to_char(r.end_month,   'YYYY-MM') AS end_month,
            r.billing_day, r.billing_cycle, r.payment_month, r.is_active
     FROM recurring_rules r
     JOIN categories c ON c.id = r.category_id
     LEFT JOIN wallets w ON w.id = r.settlement_wallet_id
     WHERE r.id = $1 AND r.user_id = $2`,
    [id, await uid()]
  );
  return rows[0] ?? null;
}

// 固定費に使える（fixed_cost の入力可）カテゴリ一覧。
export async function getFixedCostCategories(): Promise<InputCategory[]> {
  const { rows } = await pool.query(
    `SELECT id, name, pl_type FROM categories
     WHERE user_id = $1 AND pl_type = 'fixed_cost' AND is_input_allowed AND is_active
     ORDER BY display_order, id`,
    [await uid()]
  );
  return rows;
}

// ---- 資金移動（振替・チャージ・カード支払い等） ----
export type TransferRow = {
  id: number;
  date: string; // 'YYYY-MM-DD'
  kind: string; // transfer | charge | cash_withdrawal | card_settlement
  amount: number;
  fee: number;
  memo: string | null;
  from_name: string;
  to_name: string;
};

// ---- 給与明細（payslips / payslip_items） ----
export type PayslipSummary = {
  id: number;
  period: string; // 'YYYY-MM'
  gross: number; // 総支給額（支給合計）
  deduction: number; // 控除合計
  net: number; // 手取り（gross - deduction）
  total_work_hours: number | null;
  overtime_hours: number | null;
  hourly: number | null; // 時給換算（総支給 ÷ 総労働時間）
  is_confirmed: boolean;
};

export async function getPayslips(): Promise<PayslipSummary[]> {
  const { rows } = await pool.query(
    `SELECT p.id, to_char(p.period,'YYYY-MM') AS period,
            p.total_work_hours, p.overtime_hours, p.is_confirmed,
            COALESCE((SELECT SUM(amount) FROM payslip_items i WHERE i.payslip_id=p.id AND i.item_type='allowance'),0)::int AS gross,
            COALESCE((SELECT SUM(amount) FROM payslip_items i WHERE i.payslip_id=p.id AND i.item_type='deduction'),0)::int AS deduction
     FROM payslips p WHERE p.user_id=$1 ORDER BY p.period DESC`,
    [await uid()]
  );
  return rows.map((r) => {
    const wh = r.total_work_hours != null ? Number(r.total_work_hours) : null;
    const net = r.gross - r.deduction;
    return {
      id: r.id,
      period: r.period,
      gross: r.gross,
      deduction: r.deduction,
      net,
      total_work_hours: wh,
      overtime_hours: r.overtime_hours != null ? Number(r.overtime_hours) : null,
      hourly: wh && wh > 0 ? Math.round(r.gross / wh) : null,
      is_confirmed: r.is_confirmed,
    };
  });
}

export type PayslipItemRow = { name: string; amount: number };
export type PayslipEdit = {
  id: number | null;
  period: string; // 'YYYY-MM'
  total_work_hours: string;
  overtime_hours: string;
  is_confirmed: boolean;
  allowances: PayslipItemRow[];
  deductions: PayslipItemRow[];
  salary_wallet_id: number | null; // 手取りの振込先（給与収入の連動先 / ADR-049）
};

// 指定月（'YYYY-MM'）の給与明細を編集用に取得。無ければ空を返す。
export async function getPayslipForEdit(period: string): Promise<PayslipEdit> {
  const p = `${period}-01`;
  const id = await uid();
  const ps = await pool.query(
    `SELECT id, total_work_hours, overtime_hours, is_confirmed
     FROM payslips WHERE user_id=$1 AND period=$2`,
    [id, p]
  );
  // この月の給与連動取引（client_key=payslip:uid:period）の振込先を既定にする。無ければ先頭の銀行。
  const sw = await pool.query(
    `SELECT tl.wallet_id FROM transactions t
       JOIN transaction_legs tl ON tl.transaction_id = t.id
     WHERE t.user_id=$1 AND t.client_key=$2 LIMIT 1`,
    [id, `payslip:${id}:${p}`]
  );
  let salaryWalletId: number | null = sw.rows[0]?.wallet_id ?? null;
  if (salaryWalletId == null) {
    const fb = await pool.query(
      `SELECT id FROM wallets WHERE user_id=$1 AND is_active AND type='bank' ORDER BY display_order, id LIMIT 1`,
      [id]
    );
    salaryWalletId = fb.rows[0]?.id ?? null;
  }
  if (ps.rowCount === 0) {
    return { id: null, period, total_work_hours: "", overtime_hours: "", is_confirmed: false, allowances: [], deductions: [], salary_wallet_id: salaryWalletId };
  }
  const row = ps.rows[0];
  const items = await pool.query(
    `SELECT item_type, name, amount FROM payslip_items WHERE payslip_id=$1 ORDER BY id`,
    [row.id]
  );
  return {
    id: row.id,
    period,
    total_work_hours: row.total_work_hours != null ? String(Number(row.total_work_hours)) : "",
    overtime_hours: row.overtime_hours != null ? String(Number(row.overtime_hours)) : "",
    is_confirmed: row.is_confirmed,
    allowances: items.rows.filter((i) => i.item_type === "allowance").map((i) => ({ name: i.name, amount: i.amount })),
    deductions: items.rows.filter((i) => i.item_type === "deduction").map((i) => ({ name: i.name, amount: i.amount })),
    salary_wallet_id: salaryWalletId,
  };
}

// 指定月の資金移動一覧。
export async function getMonthTransfers(period = "2026-06-01"): Promise<TransferRow[]> {
  const { rows } = await pool.query(
    `SELECT t.id, to_char(t.transfer_date, 'YYYY-MM-DD') AS date, t.kind,
            t.amount, t.fee, t.memo,
            wf.name AS from_name, wt.name AS to_name
     FROM transfers t
     JOIN wallets wf ON wf.id = t.from_wallet_id
     JOIN wallets wt ON wt.id = t.to_wallet_id
     WHERE t.user_id = $1
       AND t.transfer_date >= $2::date
       AND t.transfer_date <  ($2::date + interval '1 month')
     ORDER BY t.transfer_date DESC, t.id DESC`,
    [await uid(), period]
  );
  return rows;
}
