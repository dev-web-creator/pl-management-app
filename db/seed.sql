-- ============================================================
--  初期データ(seed)  ※現運用のマスタを反映（docs/master-data.md）
--  実行: psql -d pl_app -f db/seed.sql   （schema.sql 実行後）
--  注意: 金額・引落先カードは仮置き（🔶）。実値に合わせて調整可。
-- ============================================================
BEGIN;

-- ---- ユーザー ----
INSERT INTO users (email, display_name, fiscal_year_start_month)
VALUES ('owner@example.com', 'オーナー', 4);

-- 以降 user_id はこのサブクエリで参照
-- (SELECT id FROM users WHERE email='owner@example.com')

-- ============================================================
-- ウォレット
-- ============================================================
-- 銀行（資産・残高管理）
INSERT INTO wallets (user_id, name, type, branch, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), 'みずほ銀行',   'bank', '浜松町支店',         1),
  ((SELECT id FROM users WHERE email='owner@example.com'), '三井住友銀行', 'bank', 'オリーブECRU(871)支店', 2),
  ((SELECT id FROM users WHERE email='owner@example.com'), '三菱UFJ銀行',  'bank', '国立支店',           3),
  ((SELECT id FROM users WHERE email='owner@example.com'), '楽天銀行',     'bank', 'ベース支店',         4);

-- 現金（残高は管理しない / ADR-015）
INSERT INTO wallets (user_id, name, type, is_balance_tracked, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), '現金', 'cash', false, 5);

-- プリペイド（残高管理 / ADR-024）
INSERT INTO wallets (user_id, name, type, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), 'PayPay残高',   'prepaid', 10),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'ANA Pay',      'prepaid', 11),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'JAL Pay',      'prepaid', 12),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'PASMO',        'prepaid', 13),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'ICOCA',        'prepaid', 14),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'VポイントPay', 'prepaid', 15),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'メルペイ',     'prepaid', 16);

-- ポイント（資産扱い / ADR-025）
INSERT INTO wallets (user_id, name, type, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), 'Pontaポイント',          'points', 20),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'dポイント',              'points', 21),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'PayPayポイント(自動運用)', 'points', 22);

-- クレジットカード（全て三井住友銀行から引落 / ADR-012, 023）
-- EPOS: 27締め・翌27払い ／ PayPay: 末締め・翌27払い ／ Olive: 末締め・翌26払い
INSERT INTO wallets (user_id, name, type, closing_day, closing_eom, payment_day, payment_eom, payment_month_offset, settlement_wallet_id, display_order)
VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), 'EPOSカード',   'credit_card', 27,  false, 27, false, 1,
     (SELECT id FROM wallets WHERE name='三井住友銀行' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')), 30),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'PayPayカード', 'credit_card', NULL, true, 27, false, 1,
     (SELECT id FROM wallets WHERE name='三井住友銀行' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')), 31),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'Oliveカード',  'credit_card', NULL, true, 26, false, 1,
     (SELECT id FROM wallets WHERE name='三井住友銀行' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')), 32);

-- ============================================================
-- カテゴリ（勘定科目ツリー）
-- ============================================================
-- ---- 変動費：グループ（入力不可の集計ノード）----
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, '食費',             'variable_cost', false, 100),
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, '自己投資・1人体験', 'variable_cost', false, 110),
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, '諸経費・備品購入費', 'variable_cost', false, 120);

-- 食費 > 食費(1人)（集計ノード）
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'),
   (SELECT id FROM categories WHERE name='食費' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
   '食費(1人)', 'variable_cost', false, 101);

-- 食費(1人) > 朝飯・昼飯・晩飯（葉：日次入力）
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='食費(1人)' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'variable_cost', true, v.ord
FROM (VALUES ('朝飯',1),('昼飯',2),('晩飯',3)) AS v(name, ord);

-- 食費 直下の葉
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='食費' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'variable_cost', true, v.ord
FROM (VALUES ('交際費',4),('プレゼント・奢り',5),('スーパー・まとめ買い',6)) AS v(name, ord);

-- 自己投資・1人体験 の葉
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='自己投資・1人体験' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'variable_cost', true, v.ord
FROM (VALUES ('1人体験',1),('結婚式',2)) AS v(name, ord);

-- 諸経費・備品購入費 の葉
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='諸経費・備品購入費' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'variable_cost', true, v.ord
FROM (VALUES ('旅費・交通費',1),('物品購入費',2),('その他諸経費',3),('嗜好品(TBC)',4)) AS v(name, ord);

-- 支払い利息（利子のみPL費用 / ADR-021）
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, '支払い利息', 'variable_cost', true, 190);

-- ---- 固定費 ----
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, '固定費', 'fixed_cost', false, 200);
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='固定費' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'fixed_cost', true, v.ord
FROM (VALUES ('家賃',1),('ジム',2),('生命保険',3),('携帯+YouTube',4),('定期券代',5),
             ('iCloud拡張',6),('BASE FOOD/ナッシュ',7),('Kindle',8),('Netflix',9),('Abemaプレミアム',10)) AS v(name, ord);

-- ---- 収入 ----
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, '収入', 'income', false, 300);
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='収入' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'income', true, v.ord
FROM (VALUES ('給与収入(手取り)',1),('副業・その他収益',2),('家族収入',3),('ポイント収入',4),('投資収益(配当)',5)) AS v(name, ord);

-- ---- 控除（給与天引き。支出には載せない / ADR-022）----
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, '控除', 'deduction', false, 400);
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='控除' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'deduction', true, v.ord
FROM (VALUES ('住民税',1),('所得税',2),('健康保険料',3),('雇用保険料',4),('厚生年金保険料',5),
             ('子ども・子育て支援金',6),('定額減税・確定申告還付',7),('年末調整精算額',8),('ふるさと納税返金額',9)) AS v(name, ord);

-- ---- PL対象外（残高に反映、損益には載せない / ADR-010,021）----
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), NULL, 'PL対象外', 'excluded', false, 500);
INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       (SELECT id FROM categories WHERE name='PL対象外' AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.name, 'excluded', true, v.ord
FROM (VALUES ('経費立替',1),('経費精算',2),('借入金',3),('元金返済',4)) AS v(name, ord);

-- ============================================================
-- 固定費マスタ（recurring_rules）※金額・引落先は仮置き🔶
-- ============================================================
INSERT INTO recurring_rules (user_id, name, category_id, amount, settlement_wallet_id, start_month, billing_day)
SELECT (SELECT id FROM users WHERE email='owner@example.com'),
       v.name,
       (SELECT id FROM categories WHERE name=v.cat AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       v.amount,
       (SELECT id FROM wallets WHERE name=v.wallet AND user_id=(SELECT id FROM users WHERE email='owner@example.com')),
       DATE '2026-04-01', v.bday
FROM (VALUES
  ('家賃',            '家賃',             129987, 'みずほ銀行',   27),
  ('ジム',            'ジム',               8000, 'EPOSカード',   10),
  ('生命保険',        '生命保険',           9307, 'EPOSカード',   18),
  ('携帯+YouTube',    '携帯+YouTube',       9200, 'EPOSカード',   30),
  ('定期券代',        '定期券代',          13030, 'EPOSカード',    1),
  ('iCloud拡張',      'iCloud拡張',          150, 'EPOSカード',    3),
  ('BASE FOOD/ナッシュ','BASE FOOD/ナッシュ', 4036, 'PayPayカード', 29),
  ('Kindle',          'Kindle',              980, 'PayPayカード', 15),
  ('Netflix',         'Netflix',            1490, 'PayPayカード',  1),
  ('Abemaプレミアム', 'Abemaプレミアム',    1080, 'PayPayカード',  1)
) AS v(name, cat, amount, wallet, bday);

-- ============================================================
-- 予実の目標（targets）例：総資産の月次目標
-- ============================================================
INSERT INTO targets (user_id, period, metric, amount)
SELECT (SELECT id FROM users WHERE email='owner@example.com'), DATE '2026-04-01', 'total_assets', 100000;

-- ============================================================
-- 通知ルール（ADR-042）：変動費しきい値の既定5段（10/15/20/25/30万円）
-- ============================================================
INSERT INTO notification_rules (user_id, kind, threshold)
SELECT (SELECT id FROM users WHERE email='owner@example.com'), 'variable_cost_threshold', v
FROM (VALUES (100000),(150000),(200000),(250000),(300000)) AS t(v);
UPDATE users SET notif_defaults_seeded = true WHERE email='owner@example.com';

-- ============================================================
-- 暗号資産ウォレット（ADR-043）：評価額は balance_snapshots に手入力
-- ============================================================
INSERT INTO wallets (user_id, name, type, display_order) VALUES
  ((SELECT id FROM users WHERE email='owner@example.com'), 'bitFlyer ETH', 'crypto', 100),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'bitFlyer BTC', 'crypto', 101),
  ((SELECT id FROM users WHERE email='owner@example.com'), 'bitFlyer XRP', 'crypto', 102);

COMMIT;