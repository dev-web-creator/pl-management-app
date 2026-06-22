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
