-- ============================================================
--  デモ取引データ（2026年6月） — 「1入力・全連動」体感用
--  すべて memo を 'DEMO' で始め、何度流しても重複しないよう先に削除する。
--  削除したいとき:
--    DELETE FROM transfers    WHERE user_id=1 AND memo LIKE 'DEMO%';
--    DELETE FROM transactions WHERE user_id=1 AND memo LIKE 'DEMO%';  -- legsはCASCADE
-- ============================================================
BEGIN;

DELETE FROM transfers    WHERE user_id = 1 AND memo LIKE 'DEMO%';
DELETE FROM transactions WHERE user_id = 1 AND memo LIKE 'DEMO%';

-- 取引1件＋支払い脚をまとめて入れる小道具（CTEでINSERT→RETURNINGしてleg挿入）
-- 収入: 給与手取り 420,000 → みずほ
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='給与収入(手取り)' AND user_id=1),'income',420000,'2026-06-05','DEMO 6月給与') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='みずほ銀行' AND user_id=1),420000 FROM t;

-- 収入: 副業その他 50,000 → 三井住友
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='副業・その他収益' AND user_id=1),'income',50000,'2026-06-03','DEMO 副業') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='三井住友銀行' AND user_id=1),50000 FROM t;

-- 収入: ポイント収入 3,000 → Pontaポイント（残高+）
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='ポイント収入' AND user_id=1),'income',3000,'2026-06-01','DEMO ポイント獲得') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='Pontaポイント' AND user_id=1),3000 FROM t;

-- PL対象外: 経費精算 12,000 → 三井住友（PLには載らない／残高には載る）
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='経費精算' AND user_id=1),'income',12000,'2026-06-04','DEMO 経費精算の戻り') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='三井住友銀行' AND user_id=1),12000 FROM t;

-- 固定費: 家賃 135,000 → みずほ
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='家賃' AND user_id=1),'expense',135000,'2026-06-01','DEMO 家賃') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='みずほ銀行' AND user_id=1),135000 FROM t;

-- 変動費: 昼飯 680 → PayPay残高
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='昼飯' AND user_id=1),'expense',680,'2026-06-02','DEMO 社食') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='PayPay残高' AND user_id=1),680 FROM t;

-- 変動費: 晩飯 1,200 → PayPay残高
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='晩飯' AND user_id=1),'expense',1200,'2026-06-03','DEMO 一人飯') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='PayPay残高' AND user_id=1),1200 FROM t;

-- 変動費: 交際費 8,500 → EPOSカード（クレカ＝未払い+）
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='交際費' AND user_id=1),'expense',8500,'2026-06-04','DEMO 飲み') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='EPOSカード' AND user_id=1),8500 FROM t;

-- 変動費: スーパー 4,120 → PayPayカード
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='スーパー・まとめ買い' AND user_id=1),'expense',4120,'2026-06-05','DEMO Amazon') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='PayPayカード' AND user_id=1),4120 FROM t;

-- 変動費: 物品購入費 10,000 → 【分割】EPOSカード 8,000 + Pontaポイント 2,000
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='物品購入費' AND user_id=1),'expense',10000,'2026-06-05','DEMO 分割払い(カード+ポイント)') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT t.id,x.wid,x.amt FROM t CROSS JOIN (VALUES
  ((SELECT id FROM wallets WHERE name='EPOSカード' AND user_id=1),8000),
  ((SELECT id FROM wallets WHERE name='Pontaポイント' AND user_id=1),2000)
) AS x(wid,amt);

-- 変動費: 旅費・交通費 800 → PASMO
WITH t AS (INSERT INTO transactions(user_id,category_id,type,amount,accrual_date,memo)
  VALUES (1,(SELECT id FROM categories WHERE name='旅費・交通費' AND user_id=1),'expense',800,'2026-06-06','DEMO 電車') RETURNING id)
INSERT INTO transaction_legs(transaction_id,wallet_id,amount)
SELECT id,(SELECT id FROM wallets WHERE name='PASMO' AND user_id=1),800 FROM t;

-- 資金移動（チャージ）: みずほ→PayPay残高 10,000 / EPOS→PASMO 5,000
INSERT INTO transfers(user_id,from_wallet_id,to_wallet_id,amount,kind,transfer_date,memo) VALUES
 (1,(SELECT id FROM wallets WHERE name='みずほ銀行' AND user_id=1),(SELECT id FROM wallets WHERE name='PayPay残高' AND user_id=1),10000,'charge','2026-06-01','DEMO チャージ'),
 (1,(SELECT id FROM wallets WHERE name='EPOSカード' AND user_id=1),(SELECT id FROM wallets WHERE name='PASMO' AND user_id=1),5000,'charge','2026-06-01','DEMO チャージ');

COMMIT;
