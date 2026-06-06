-- ============================================================
--  集計クエリ集（「合計は持たず算出する」設計の実証）
--  そのまま将来の API / 画面の読み取りクエリに転用できる。
--  実行: psql -d pl_app -f db/queries.sql
-- ============================================================
\echo '==================== ① 変動費ツリーの自動ロールアップ ===================='
\echo '（葉=朝/昼/晩などに入力 → 上位 食費(1人)・食費・変動費合計が自動集計される）'
WITH RECURSIVE
leaf AS (  -- カテゴリ別の取引合計（葉）
  SELECT category_id, SUM(amount) AS amt
  FROM transactions WHERE user_id=1 AND type='expense'
  GROUP BY category_id
),
subtree AS (  -- (祖先, 子孫) の全ペア。各カテゴリの配下を辿る
  SELECT id AS root_id, id AS node_id FROM categories WHERE user_id=1
  UNION ALL
  SELECT s.root_id, c.id FROM subtree s JOIN categories c ON c.parent_id = s.node_id
)
SELECT c.id, c.name AS カテゴリ, c.is_input_allowed AS 入力可,
       COALESCE(SUM(l.amt),0) AS 配下合計
FROM categories c
JOIN subtree s ON s.root_id = c.id
LEFT JOIN leaf l ON l.category_id = s.node_id
WHERE c.user_id=1 AND c.pl_type='variable_cost'
GROUP BY c.id, c.name, c.is_input_allowed
ORDER BY c.id;

\echo ''
\echo '==================== ② ウォレット残高（取引＋振替から算出） ===================='
WITH legs AS (
  SELECT tl.wallet_id,
    SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
  FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
  WHERE t.user_id=1 GROUP BY tl.wallet_id
),
tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)       AS a FROM transfers WHERE user_id=1 GROUP BY to_wallet_id),
tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee)   AS a FROM transfers WHERE user_id=1 GROUP BY from_wallet_id)
SELECT w.name AS ウォレット, w.type AS 種別,
  w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0) AS 残高
FROM wallets w
LEFT JOIN legs   ON legs.wallet_id = w.id
LEFT JOIN tr_in  ON tr_in.wid  = w.id
LEFT JOIN tr_out ON tr_out.wid = w.id
WHERE w.user_id=1
  AND (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0)) <> 0
ORDER BY w.type, w.id;

\echo ''
\echo '==================== ②-2 総資産・純資産（カード未払いを差し引く） ===================='
WITH legs AS (
  SELECT tl.wallet_id,
    SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
  FROM transaction_legs tl JOIN transactions t ON t.id=tl.transaction_id
  WHERE t.user_id=1 GROUP BY tl.wallet_id
),
tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)     AS a FROM transfers WHERE user_id=1 GROUP BY to_wallet_id),
tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers WHERE user_id=1 GROUP BY from_wallet_id),
bal AS (
  SELECT w.type, w.include_in_assets,
    w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0) AS balance
  FROM wallets w
  LEFT JOIN legs ON legs.wallet_id=w.id
  LEFT JOIN tr_in ON tr_in.wid=w.id
  LEFT JOIN tr_out ON tr_out.wid=w.id
  WHERE w.user_id=1
)
SELECT
  SUM(balance) FILTER (WHERE type<>'credit_card' AND include_in_assets) AS 総資産,
  -SUM(balance) FILTER (WHERE type='credit_card')                       AS カード未払い,
  SUM(balance)                                                          AS 純資産
FROM bal;

\echo ''
\echo '==================== ③ PLサマリ（2026年6月）====================='
\echo '（可処分所得 − 固定費 − 変動費 = 月次黒字。経費精算=PL対象外は別枠）'
WITH x AS (
  SELECT t.type, c.pl_type, t.amount
  FROM transactions t JOIN categories c ON c.id=t.category_id
  WHERE t.user_id=1 AND t.accrual_date >= DATE '2026-06-01' AND t.accrual_date < DATE '2026-07-01'
)
SELECT
  COALESCE(SUM(amount) FILTER (WHERE type='income'  AND pl_type='income'),0)        AS 可処分所得,
  COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type='fixed_cost'),0)    AS 固定費,
  COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type='variable_cost'),0) AS 変動費,
  COALESCE(SUM(amount) FILTER (WHERE type='income'  AND pl_type='income'),0)
   - COALESCE(SUM(amount) FILTER (WHERE type='expense' AND pl_type IN ('fixed_cost','variable_cost')),0) AS 月次黒字,
  COALESCE(SUM(amount) FILTER (WHERE pl_type='excluded'),0)                          AS PL対象外_参考
FROM x;
