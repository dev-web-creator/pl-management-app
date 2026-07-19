-- ADR-043: 暗号資産の資産管理（wallet type='crypto'）
-- 本番はオートマイグレーション（lib/db.ts の ensureMigrated）で適用済み。正式DDLの控え。
-- crypto ウォレットの残高＝balance_snapshots の最新 actual_balance（評価額の手入力）を「正」とする。
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_type_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_type_check
  CHECK (type IN ('bank','credit_card','prepaid','points','cash','crypto'));
