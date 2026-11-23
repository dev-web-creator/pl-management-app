-- カード消込の二重登録をDB側で防ぐ（ADR-040と同じ考え方の砦）。
-- アプリ側の「SELECTしてから INSERT」は、複数インスタンスが同時に動く本番では
-- すり抜ける。銀行から請求額が2回引かれるのを防ぐため、DBで一意性を強制する。
-- 論理キー = ユーザー × カード × 締めサイクル(memoに埋まっている)。
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_settlement
  ON transfers (user_id, to_wallet_id, memo)
  WHERE kind = 'card_settlement';
