-- ADR-042: 通知基盤（変動費しきい値メール通知）
-- 本番はオートマイグレーション（lib/db.ts の ensureMigrated）で適用済み。正式DDLの控え。

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

-- 既定ルール（10/15/20/25/30万円）を未投入ユーザーへ一度だけ投入
-- （フラグ方式：ユーザーが全ルールを削除しても勝手に復活しない）
INSERT INTO notification_rules (user_id, kind, threshold)
SELECT u.id, 'variable_cost_threshold', t.v
FROM users u
CROSS JOIN (VALUES (100000),(150000),(200000),(250000),(300000)) AS t(v)
WHERE NOT u.notif_defaults_seeded
ON CONFLICT (user_id, kind, threshold) DO NOTHING;

UPDATE users SET notif_defaults_seeded = true WHERE NOT notif_defaults_seeded;
