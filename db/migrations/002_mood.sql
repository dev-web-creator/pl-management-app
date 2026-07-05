-- 002: 取引に「気分」列を追加（ADR-036）
-- 現運用のGoogleフォーム「いまどんな気持ちですか？」の再現。1(最悪)〜5(最高)。
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS mood smallint CHECK (mood BETWEEN 1 AND 5);
