-- ============================================================
--  個人向けPL管理・家計簿アプリ  スキーマ定義 (PostgreSQL)
--  根拠: docs/database-design.md / docs/decisions.md (ADR)
--  実行: psql -d pl_app -f db/schema.sql
-- ============================================================
--  方針メモ:
--   - 主キー(PK): bigint GENERATED ALWAYS AS IDENTITY（自動採番の背番号）
--   - 外部キー(FK): 親テーブルのidを指し、参照整合性を強制
--   - 金額: integer（円単位の整数。日本円は小数なし＝誤差ゼロ）
--   - 暦日: date / 記録時刻: timestamptz / 年月: 月初日のdate
-- ============================================================

BEGIN;

-- 既存を作り直す場合（開発用）。本番では使わない。
DROP TABLE IF EXISTS vision_notes, balance_snapshots, payslip_items, payslips,
  monthly_closings, targets, transaction_legs, transactions,
  transfers, card_statements, recurring_rules, categories, wallets, users CASCADE;
DROP FUNCTION IF EXISTS set_updated_at CASCADE;

-- updated_at を自動更新する共通トリガ関数（学習用の小道具）
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 1. users（ユーザー＋設定）
-- ------------------------------------------------------------
CREATE TABLE users (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                    text NOT NULL UNIQUE,
  display_name             text,
  fiscal_year_start_month  smallint NOT NULL DEFAULT 4
                             CHECK (fiscal_year_start_month BETWEEN 1 AND 12), -- FY開始月(可変/ADR-017)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 2. wallets（口座/カード/プリペイド/ポイント/現金）
-- ------------------------------------------------------------
CREATE TABLE wallets (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  type                  text NOT NULL
                          CHECK (type IN ('bank','credit_card','prepaid','points','cash')),
  branch                text,                         -- 支店（浜松町 等）
  initial_balance       integer NOT NULL DEFAULT 0,   -- 開始残高（現在残高の起点/ADR-002）
  is_balance_tracked    boolean NOT NULL DEFAULT true, -- 現金=false（残高は追わない/ADR-015）
  include_in_assets     boolean NOT NULL DEFAULT true, -- 資産合計に含めるか（ADR-026）
  display_order         integer NOT NULL DEFAULT 0,
  is_active             boolean NOT NULL DEFAULT true,
  -- ↓ カード専用（type='credit_card'のときのみ使用）
  closing_day           smallint CHECK (closing_day BETWEEN 1 AND 31), -- 締め日
  closing_eom           boolean NOT NULL DEFAULT false,                -- 末締めか
  payment_day           smallint CHECK (payment_day BETWEEN 1 AND 31), -- 支払日
  payment_eom           boolean NOT NULL DEFAULT false,                -- 末払いか
  payment_month_offset  smallint NOT NULL DEFAULT 1,                   -- 締め→支払い(翌月=1)
  settlement_wallet_id  bigint REFERENCES wallets(id) ON DELETE SET NULL, -- 引落先(自己参照/ADR-012)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE TRIGGER trg_wallets_updated BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 3. categories（勘定科目ツリー：自己参照＋PL区分）
-- ------------------------------------------------------------
CREATE TABLE categories (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id         bigint REFERENCES categories(id) ON DELETE RESTRICT, -- ルートはNULL
  name              text NOT NULL,
  pl_type           text NOT NULL
                      CHECK (pl_type IN ('income','fixed_cost','variable_cost','deduction','excluded')),
  is_input_allowed  boolean NOT NULL DEFAULT true,  -- 集計ノード=false（食費(1人)等/ADR-008）
  display_order     integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_categories_user ON categories(user_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE TRIGGER trg_categories_updated BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 8. card_statements（クレカ請求サイクル）
--    ※ transactions/transfers より先に作る（両者が参照するため）
--    paid_transfer_id のFKは transfers 作成後に ALTER で付与（循環参照の解消）
-- ------------------------------------------------------------
CREATE TABLE card_statements (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id             bigint NOT NULL REFERENCES wallets(id) ON DELETE CASCADE, -- 対象カード
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  closing_date          date NOT NULL,
  payment_date          date NOT NULL,                 -- 引落予定日
  settlement_wallet_id  bigint REFERENCES wallets(id) ON DELETE SET NULL, -- 引落先(通常 三井住友)
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','closed','paid')),
  paid_transfer_id      bigint,  -- FKは後付け（→transfers.id）
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cardstmt_wallet ON card_statements(wallet_id);
CREATE TRIGGER trg_cardstmt_updated BEFORE UPDATE ON card_statements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 4. transactions（取引：収入/支出、発生主義）
-- ------------------------------------------------------------
CREATE TABLE transactions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id        bigint NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  type               text NOT NULL CHECK (type IN ('expense','income')),
  amount             integer NOT NULL CHECK (amount > 0),  -- 総額(満額)/ADR-025
  accrual_date       date NOT NULL,                        -- 発生日＝PL計上日/ADR-001
  is_confirmed       boolean NOT NULL DEFAULT true,         -- 予実の確定フラグ
  card_statement_id  bigint REFERENCES card_statements(id) ON DELETE SET NULL,
  memo               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tx_user_date ON transactions(user_id, accrual_date);
CREATE INDEX idx_tx_category ON transactions(category_id);
CREATE INDEX idx_tx_statement ON transactions(card_statement_id);
CREATE TRIGGER trg_tx_updated BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 5. transaction_legs（支払い脚：分割支払い対応/ADR-025）
-- ------------------------------------------------------------
CREATE TABLE transaction_legs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  bigint NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  wallet_id       bigint NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  amount          integer NOT NULL CHECK (amount > 0)  -- 脚の合計＝取引金額(アプリで担保)
);
CREATE INDEX idx_legs_tx ON transaction_legs(transaction_id);
CREATE INDEX idx_legs_wallet ON transaction_legs(wallet_id);

-- ------------------------------------------------------------
-- 6. transfers（資金移動：振替/チャージ/現金出し/クレカ消込）
-- ------------------------------------------------------------
CREATE TABLE transfers (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_wallet_id     bigint NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  to_wallet_id       bigint NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  amount             integer NOT NULL CHECK (amount > 0),
  fee                integer NOT NULL DEFAULT 0 CHECK (fee >= 0),  -- 手数料
  fee_category_id    bigint REFERENCES categories(id) ON DELETE SET NULL,
  kind               text NOT NULL DEFAULT 'transfer'
                       CHECK (kind IN ('transfer','charge','cash_withdrawal','card_settlement')),
  card_statement_id  bigint REFERENCES card_statements(id) ON DELETE SET NULL, -- 消込対象
  transfer_date      date NOT NULL,
  memo               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (from_wallet_id <> to_wallet_id)
);
CREATE INDEX idx_transfers_user_date ON transfers(user_id, transfer_date);
CREATE INDEX idx_transfers_from ON transfers(from_wallet_id);
CREATE INDEX idx_transfers_to ON transfers(to_wallet_id);
CREATE TRIGGER trg_transfers_updated BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 循環参照の後付けFK：card_statements.paid_transfer_id → transfers.id
ALTER TABLE card_statements
  ADD CONSTRAINT fk_cardstmt_paid_transfer
  FOREIGN KEY (paid_transfer_id) REFERENCES transfers(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 7. recurring_rules（固定費・サブスクマスタ）
-- ------------------------------------------------------------
CREATE TABLE recurring_rules (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  category_id           bigint NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  amount                integer NOT NULL CHECK (amount >= 0),
  settlement_wallet_id  bigint NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT, -- 引落先/ADR-012
  start_month           date NOT NULL,         -- 開始年月(月初日)
  end_month             date,                  -- 終了年月。NULL=継続中。解約でセット/ADR-011
  billing_day           smallint CHECK (billing_day BETWEEN 1 AND 31),
  is_active             boolean NOT NULL DEFAULT true,
  memo                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_recurring_user ON recurring_rules(user_id);
CREATE TRIGGER trg_recurring_updated BEFORE UPDATE ON recurring_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 9. targets（予実の予算・目標：収入/支出/収支/総資産）
-- ------------------------------------------------------------
CREATE TABLE targets (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period     date NOT NULL,                    -- 対象年月(月初日)
  metric     text NOT NULL
               CHECK (metric IN ('income','expense','net_balance','total_assets')),
  amount     integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period, metric)
);
CREATE TRIGGER trg_targets_updated BEFORE UPDATE ON targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 10. monthly_closings（確定/未確定＝黒塗り/ADR-020）
-- ------------------------------------------------------------
CREATE TABLE monthly_closings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period     date NOT NULL,
  section    text NOT NULL
               CHECK (section IN ('income','fixed_cost','variable_cost','assets')),
  is_closed  boolean NOT NULL DEFAULT false,
  closed_at  timestamptz,
  UNIQUE (user_id, period, section)
);

-- ------------------------------------------------------------
-- 11. payslips（給与明細）
-- ------------------------------------------------------------
CREATE TABLE payslips (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period           date NOT NULL,                 -- 対象年月
  total_work_hours numeric(6,1),                  -- 総労働時間(KPI/ADR-009)
  overtime_hours   numeric(6,1),                  -- 時間外労働時間
  is_confirmed     boolean NOT NULL DEFAULT false,
  source           text CHECK (source IN ('ocr','manual')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period)
);
CREATE TRIGGER trg_payslips_updated BEFORE UPDATE ON payslips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 12. payslip_items（給与明細の明細行：手当/控除）
-- ------------------------------------------------------------
CREATE TABLE payslip_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payslip_id  bigint NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  item_type   text NOT NULL CHECK (item_type IN ('allowance','deduction')),
  name        text NOT NULL,
  category_id bigint REFERENCES categories(id) ON DELETE SET NULL,
  amount      integer NOT NULL  -- 控除は+で持ち減算。還付は−可（ADR-022）
);
CREATE INDEX idx_payslip_items_payslip ON payslip_items(payslip_id);

-- ------------------------------------------------------------
-- 13. balance_snapshots（任意のリコンサイル/ADR-027）
-- ------------------------------------------------------------
CREATE TABLE balance_snapshots (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id      bigint NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  as_of_date     date NOT NULL,
  actual_balance integer NOT NULL,     -- 実残高(手入力)
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, as_of_date)
);

-- ------------------------------------------------------------
-- 14. vision_notes（ビジョン/目標の自由記述：1ユーザー1箱）
-- ------------------------------------------------------------
CREATE TABLE vision_notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

COMMIT;
