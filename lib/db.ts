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
-- 冪等キー（二重入力防止 / ADR-039）: 同じ client_key の再送信は新規作成せず既存を返す
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS client_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_user_client_key
  ON transactions(user_id, client_key) WHERE client_key IS NOT NULL;
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
