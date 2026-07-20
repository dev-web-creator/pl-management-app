import { Pool } from "pg";

// 接続プール（アプリ全体で1つ使い回す）
// DATABASE_URL は .env.local に記載: postgresql://postgres@localhost:5432/pl_app
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---- 起動時オートマイグレーション ----
// 冪等（IF NOT EXISTS）な追加変更のみをここに置く。コールドスタート毎に
// 実行されるが、適用済みなら一瞬の no-op。破壊的変更は絶対に書かない。
// （デプロイとDB変更の順序問題を無くすための仕組み / ADR-035）
const MIGRATIONS = `
ALTER TABLE recurring_rules
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS payment_month smallint;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS mood smallint;
-- 冪等キー（二重入力防止 / ADR-040）: 同じ client_key の再送信は新規作成せず既存を返す
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS client_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_user_client_key
  ON transactions(user_id, client_key) WHERE client_key IS NOT NULL;
-- 通知基盤（ADR-042）: ルール＋送信履歴。既定ルールはフラグ方式で一度だけ投入
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notif_defaults_seeded boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS notification_rules (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'variable_cost_threshold'
               CHECK (kind IN ('variable_cost_threshold')),
  threshold  integer NOT NULL CHECK (threshold > 0),
  channel    text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, threshold)
);
CREATE TABLE IF NOT EXISTS notification_log (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id  bigint NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
  period   date NOT NULL,
  sent_to  text,
  detail   text,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, period)
);
CREATE INDEX IF NOT EXISTS idx_notiflog_user ON notification_log(user_id, period);
INSERT INTO notification_rules (user_id, kind, threshold)
SELECT u.id, 'variable_cost_threshold', t.v
FROM users u
CROSS JOIN (VALUES (100000),(150000),(200000),(250000),(300000)) AS t(v)
WHERE NOT u.notif_defaults_seeded
ON CONFLICT (user_id, kind, threshold) DO NOTHING;
UPDATE users SET notif_defaults_seeded = true WHERE NOT notif_defaults_seeded;
-- 暗号資産（ADR-043）: wallets.type に 'crypto' を追加（残高＝最新スナップショットの評価額）
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_type_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_type_check
  CHECK (type IN ('bank','credit_card','prepaid','points','cash','crypto'));
-- 機能の表示ON/OFF（ADR-046）: 非表示にしたページのhref配列
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS hidden_pages jsonb NOT NULL DEFAULT '[]'::jsonb;
`;

let migrated: Promise<void> | null = null;

/** 初回クエリの前に一度だけ実行される（失敗してもアプリは落とさずログのみ） */
export function ensureMigrated(): Promise<void> {
  if (!migrated) {
    migrated = pool
      .query(MIGRATIONS)
      .then(() => undefined)
      .catch((e) => {
        console.error("auto-migration failed:", e);
      });
  }
  return migrated;
}

export default pool;
