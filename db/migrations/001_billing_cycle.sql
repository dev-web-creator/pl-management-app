-- 001: 固定費マスタに 月額/年額 区分を追加（ADR-035）
-- 既存行はすべて 'monthly' になる（後方互換・安全な追加変更）。
-- 適用: ローカル → psql -d pl_app -f db/migrations/001_billing_cycle.sql
--       本番(Neon) → 同じSQLを実行
ALTER TABLE recurring_rules
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly','yearly')),
  ADD COLUMN IF NOT EXISTS payment_month smallint
    CHECK (payment_month BETWEEN 1 AND 12);
