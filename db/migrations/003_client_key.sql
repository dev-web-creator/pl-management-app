-- ADR-040: 取引の冪等キー（二重入力防止）
-- 本番はオートマイグレーション（lib/db.ts の ensureMigrated）で適用済み。正式DDLの控え。
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS client_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_user_client_key
  ON transactions(user_id, client_key) WHERE client_key IS NOT NULL;
