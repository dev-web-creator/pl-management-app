-- ============================================================
--  10/1 並行運用カットオーバー前のデータ整理
--  実行前に必ずバックアップを取ること:
--    pg_dump -Fc -d <DB> -f backups/<日付>.dump
--
--  ① db/seed.sql 由来のDEMOデータ（2026-06に11件・¥645,300）
--     実データと混在しており、2026-06の給与と家賃を二重に見せている。
--  ② 未来日付のインポート行（2026-10/11/12に各¥40,700・脚なし）
--     並行運用初日(10/1)に既に支出が入っている状態を解消する。
--     ADR-045のインポータが未来日付を除外していなかったことに起因。
--
--  transaction_legs は ON DELETE CASCADE で自動削除される。
-- ============================================================
BEGIN;

-- 削除前の件数を記録（実行ログに残す）
\echo '--- 削除前 ---'
SELECT count(*) AS 全取引 FROM transactions;

-- ① DEMOデータ
DELETE FROM transactions WHERE memo LIKE 'DEMO%';

-- ② 今日以降の日付を持つインポート行
--    ※手入力した予定を消さないよう、インポート由来(client_key='imp:%')に限定する
DELETE FROM transactions
WHERE accrual_date >= CURRENT_DATE
  AND client_key LIKE 'imp:%';

\echo '--- 削除後 ---'
SELECT count(*) AS 全取引 FROM transactions;
SELECT count(*) AS 残DEMO FROM transactions WHERE memo LIKE 'DEMO%';
SELECT count(*) AS 残未来日付 FROM transactions WHERE accrual_date >= CURRENT_DATE;

COMMIT;
