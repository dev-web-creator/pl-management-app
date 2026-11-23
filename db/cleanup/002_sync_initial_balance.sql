-- ============================================================
--  期首残高(initial_balance)を実残高に合わせる（カットオーバー用）
--
--  【使い方】
--   1. /reconcile を開き、各ウォレットの「実残高」に運用開始日の前日時点の実際の残高を入力して記録する
--      （当初は 10/1 開始で 9/30 を想定。2026-12-01 開始に変更したので 11/30 時点。ADR-057）
--      （balance_snapshots に as_of_date 付きで保存される）
--   2. このスクリプトを実行する
--   3. /reconcile を再度開き、「差分」が全て 0 になっていることを確認する
--
--  【考え方】
--   算出残高 = initial_balance + 脚の増減 + 振替の増減
--   これを実残高に一致させたいので、差分(実残高 - 算出残高)を initial_balance に足す。
--   脚や振替が既にいくつ入っていても正しく効く。
--
--  【対象外】
--   - crypto: 残高は最新スナップショットを直接「正」とする設計(ADR-043)のため触らない
--   - スナップショット未記録のウォレット: 合わせる先が無いので触らない
--
--  実行前にバックアップを取ること。
-- ============================================================
BEGIN;

WITH legs AS (
  SELECT tl.wallet_id,
         SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
  FROM transaction_legs tl JOIN transactions t ON t.id = tl.transaction_id
  GROUP BY tl.wallet_id
),
tr_in  AS (SELECT to_wallet_id   AS wid, SUM(amount)     AS a FROM transfers GROUP BY to_wallet_id),
tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers GROUP BY from_wallet_id),
latest AS (
  SELECT DISTINCT ON (wallet_id) wallet_id, actual_balance, as_of_date
  FROM balance_snapshots
  ORDER BY wallet_id, as_of_date DESC
),
calc AS (
  SELECT w.id,
         w.name,
         w.initial_balance AS old_initial,
         (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0))::int AS computed,
         l.actual_balance AS actual,
         l.as_of_date
  FROM wallets w
  JOIN latest l ON l.wallet_id = w.id
  LEFT JOIN legs   ON legs.wallet_id = w.id
  LEFT JOIN tr_in  ON tr_in.wid  = w.id
  LEFT JOIN tr_out ON tr_out.wid = w.id
  WHERE w.type <> 'crypto'
)
UPDATE wallets w
SET initial_balance = c.old_initial + (c.actual - c.computed)
FROM calc c
WHERE w.id = c.id
  AND c.actual <> c.computed;

-- 結果確認：差分が全て0になっているはず
WITH legs AS (
  SELECT tl.wallet_id, SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
  FROM transaction_legs tl JOIN transactions t ON t.id = tl.transaction_id GROUP BY tl.wallet_id
),
tr_in  AS (SELECT to_wallet_id AS wid, SUM(amount) AS a FROM transfers GROUP BY to_wallet_id),
tr_out AS (SELECT from_wallet_id AS wid, SUM(amount+fee) AS a FROM transfers GROUP BY from_wallet_id),
latest AS (
  SELECT DISTINCT ON (wallet_id) wallet_id, actual_balance FROM balance_snapshots
  ORDER BY wallet_id, as_of_date DESC
)
SELECT w.name AS ウォレット,
       w.initial_balance AS 新しい期首残高,
       (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0))::int AS 算出残高,
       l.actual_balance AS 実残高,
       (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0))::int - l.actual_balance AS 差分
FROM wallets w
JOIN latest l ON l.wallet_id = w.id
LEFT JOIN legs ON legs.wallet_id = w.id
LEFT JOIN tr_in ON tr_in.wid = w.id
LEFT JOIN tr_out ON tr_out.wid = w.id
WHERE w.type <> 'crypto' AND w.is_active
ORDER BY w.type, w.id;

COMMIT;
