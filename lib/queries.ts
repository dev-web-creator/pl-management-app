import pool from "@/lib/db";

// MVPは単一ユーザー。将来は認証から取得する。
const USER_ID = 1;

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
    [USER_ID, period]
  );
  return rows[0];
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
     tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers WHERE user_id=$1 GROUP BY from_wallet_id)
     SELECT w.name, w.type,
       (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0))::int AS balance
     FROM wallets w
     LEFT JOIN legs   ON legs.wallet_id = w.id
     LEFT JOIN tr_in  ON tr_in.wid  = w.id
     LEFT JOIN tr_out ON tr_out.wid = w.id
     WHERE w.user_id = $1
       AND (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0)) <> 0
     ORDER BY w.type, w.id`,
    [USER_ID]
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
         (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0)) AS balance
       FROM wallets w
       LEFT JOIN legs ON legs.wallet_id=w.id
       LEFT JOIN tr_in ON tr_in.wid=w.id
       LEFT JOIN tr_out ON tr_out.wid=w.id
       WHERE w.user_id=$1
     )
     SELECT
       COALESCE(SUM(balance) FILTER (WHERE type<>'credit_card' AND include_in_assets),0)::int AS total_assets,
       COALESCE(-SUM(balance) FILTER (WHERE type='credit_card'),0)::int                       AS card_unpaid,
       COALESCE(SUM(balance),0)::int                                                          AS net_assets
     FROM bal`,
    [USER_ID]
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
    [USER_ID]
  );
  return rows;
}

export type WalletOption = { id: number; name: string; type: string };

// ウォレット一覧。決済手段プルダウン用。
export async function getWalletOptions(): Promise<WalletOption[]> {
  const { rows } = await pool.query(
    `SELECT id, name, type FROM wallets
     WHERE user_id=$1 AND is_active
     ORDER BY type, display_order, id`,
    [USER_ID]
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
  const { rows } = await pool.query(`SELECT content FROM vision_notes WHERE user_id=$1`, [USER_ID]);
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
    [USER_ID]
  );
  return rows;
}

// ---- FY（会計年度）年次ビュー（ADR-007/017） ----
export async function getUserFyStartMonth(): Promise<number> {
  const { rows } = await pool.query(`SELECT fiscal_year_start_month FROM users WHERE id=$1`, [USER_ID]);
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
    [USER_ID, startPeriod]
  );
  return rows.map((r) => ({ ...r, surplus: r.income - r.fixed - r.variable }));
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
    [USER_ID]
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
    [USER_ID]
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
    [USER_ID, period]
  );
  return rows[0]?.amount ?? 0;
}

export async function getBudgetVsActual(period: string): Promise<BudgetVsActual> {
  const t = await pool.query(`SELECT metric, amount FROM targets WHERE user_id=$1 AND period=$2`, [
    USER_ID,
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
    [USER_ID, period]
  );

  const c = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE is_closed)::int AS closed_n
     FROM monthly_closings
     WHERE user_id=$1 AND period=$2 AND section IN ('income','fixed_cost','variable_cost')`,
    [USER_ID, period]
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
     aw AS (SELECT id FROM wallets WHERE user_id=$1 AND include_in_assets AND type<>'credit_card'),
     cw AS (SELECT id FROM wallets WHERE user_id=$1 AND type='credit_card'),
     init AS (SELECT COALESCE(SUM(initial_balance),0) AS v FROM wallets WHERE user_id=$1 AND include_in_assets AND type<>'credit_card')
     SELECT to_char(mo.m,'YYYY-MM') AS month,
       ((SELECT v FROM init)
        + COALESCE((SELECT SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END)
                    FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
                    WHERE t.user_id=$1 AND tl.wallet_id IN (SELECT id FROM aw) AND t.accrual_date < (mo.m + interval '1 month')),0)
        + COALESCE((SELECT SUM(amount)     FROM transfers WHERE user_id=$1 AND to_wallet_id   IN (SELECT id FROM aw) AND transfer_date < (mo.m + interval '1 month')),0)
        - COALESCE((SELECT SUM(amount+fee) FROM transfers WHERE user_id=$1 AND from_wallet_id IN (SELECT id FROM aw) AND transfer_date < (mo.m + interval '1 month')),0)
       )::int AS total_assets,
       ( COALESCE((SELECT SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END)
                    FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
                    WHERE t.user_id=$1 AND tl.wallet_id IN (SELECT id FROM cw) AND t.accrual_date < (mo.m + interval '1 month')),0)
        + COALESCE((SELECT SUM(amount)     FROM transfers WHERE user_id=$1 AND to_wallet_id   IN (SELECT id FROM cw) AND transfer_date < (mo.m + interval '1 month')),0)
        - COALESCE((SELECT SUM(amount+fee) FROM transfers WHERE user_id=$1 AND from_wallet_id IN (SELECT id FROM cw) AND transfer_date < (mo.m + interval '1 month')),0)
       )::int AS card_balance
     FROM months mo ORDER BY mo.m`,
    [USER_ID]
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
         (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0)) AS balance
       FROM wallets w
       LEFT JOIN legs ON legs.wallet_id=w.id LEFT JOIN tr_in ON tr_in.wid=w.id LEFT JOIN tr_out ON tr_out.wid=w.id
       WHERE w.user_id=$1
     )
     SELECT type, SUM(balance)::int AS total FROM bal
     WHERE include_in_assets AND type<>'credit_card'
     GROUP BY type HAVING SUM(balance) <> 0 ORDER BY total DESC`,
    [USER_ID]
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
    [USER_ID]
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
    [USER_ID, period]
  );
  return rows;
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
export async function getFixedCostPlanVsActual(
  period = "2026-06-01"
): Promise<FixedCostItem[]> {
  const { rows } = await pool.query(
    `WITH active_rules AS (
       SELECT r.id, r.name, r.category_id, r.amount AS plan, w.name AS wallet_name
       FROM recurring_rules r
       LEFT JOIN wallets w ON w.id = r.settlement_wallet_id
       WHERE r.user_id = $1 AND r.is_active
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
     )
     SELECT ar.id, ar.name, ar.plan, ar.wallet_name,
            a.act                       AS actual,
            COALESCE(a.act, ar.plan)::int AS effective,
            (a.act IS NOT NULL)         AS is_actual
     FROM active_rules ar
     LEFT JOIN actual a ON a.category_id = ar.category_id
     ORDER BY ar.plan DESC, ar.id`,
    [USER_ID, period]
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
  wallets: string | null; // 支払い脚のウォレット名（分割は ' + ' 連結）
};

// 指定月の取引一覧（カテゴリ名・決済ウォレット名つき）。発生日の新しい順。
export async function getMonthTransactions(period = "2026-06-01"): Promise<TxRow[]> {
  const { rows } = await pool.query(
    `SELECT t.id,
            to_char(t.accrual_date, 'YYYY-MM-DD') AS date,
            c.name AS category, c.pl_type, t.type, t.amount, t.memo,
            string_agg(w.name, ' + ' ORDER BY tl.id) AS wallets
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN transaction_legs tl ON tl.transaction_id = t.id
     LEFT JOIN wallets w ON w.id = tl.wallet_id
     WHERE t.user_id = $1
       AND t.accrual_date >= $2::date
       AND t.accrual_date <  ($2::date + interval '1 month')
     GROUP BY t.id, c.name, c.pl_type, t.type, t.amount, t.memo, t.accrual_date
     ORDER BY t.accrual_date DESC, t.id DESC`,
    [USER_ID, period]
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
    [id, USER_ID]
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
  is_active: boolean;
};

// 固定費マスタ一覧（継続中→終了済みの順）。
export async function getRecurringRules(): Promise<RecurringRule[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.amount, r.category_id, c.name AS category_name,
            r.settlement_wallet_id, w.name AS wallet_name,
            to_char(r.start_month, 'YYYY-MM') AS start_month,
            to_char(r.end_month,   'YYYY-MM') AS end_month,
            r.billing_day, r.is_active
     FROM recurring_rules r
     JOIN categories c ON c.id = r.category_id
     LEFT JOIN wallets w ON w.id = r.settlement_wallet_id
     WHERE r.user_id = $1
     ORDER BY (r.end_month IS NOT NULL), r.amount DESC, r.id`,
    [USER_ID]
  );
  return rows;
}

export async function getRecurringRuleForEdit(id: number): Promise<RecurringRule | null> {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.amount, r.category_id, c.name AS category_name,
            r.settlement_wallet_id, w.name AS wallet_name,
            to_char(r.start_month, 'YYYY-MM') AS start_month,
            to_char(r.end_month,   'YYYY-MM') AS end_month,
            r.billing_day, r.is_active
     FROM recurring_rules r
     JOIN categories c ON c.id = r.category_id
     LEFT JOIN wallets w ON w.id = r.settlement_wallet_id
     WHERE r.id = $1 AND r.user_id = $2`,
    [id, USER_ID]
  );
  return rows[0] ?? null;
}

// 固定費に使える（fixed_cost の入力可）カテゴリ一覧。
export async function getFixedCostCategories(): Promise<InputCategory[]> {
  const { rows } = await pool.query(
    `SELECT id, name, pl_type FROM categories
     WHERE user_id = $1 AND pl_type = 'fixed_cost' AND is_input_allowed AND is_active
     ORDER BY display_order, id`,
    [USER_ID]
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
    [USER_ID]
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
};

// 指定月（'YYYY-MM'）の給与明細を編集用に取得。無ければ空を返す。
export async function getPayslipForEdit(period: string): Promise<PayslipEdit> {
  const p = `${period}-01`;
  const ps = await pool.query(
    `SELECT id, total_work_hours, overtime_hours, is_confirmed
     FROM payslips WHERE user_id=$1 AND period=$2`,
    [USER_ID, p]
  );
  if (ps.rowCount === 0) {
    return { id: null, period, total_work_hours: "", overtime_hours: "", is_confirmed: false, allowances: [], deductions: [] };
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
    [USER_ID, period]
  );
  return rows;
}
