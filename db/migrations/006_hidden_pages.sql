-- ADR-046: 機能の表示ON/OFF（ユーザーごとに使わないページをナビから隠す）
-- 本番はオートマイグレーション（lib/db.ts の ensureMigrated）で適用済み。正式DDLの控え。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS hidden_pages jsonb NOT NULL DEFAULT '[]'::jsonb;
