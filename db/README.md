# データベースのセットアップと検証

このディレクトリのSQL：
- `schema.sql` … テーブル定義（DDL）。13テーブル＋トリガ。
- `seed.sql` … 初期データ（ウォレット・カテゴリ・固定費マスタ等）。`schema.sql`の後に実行。
- `dev/queries.sql` … 集計クエリ集（学習用。`lib/queries.ts` と同内容）。

設計の根拠は `../docs/database-design.md` と `../docs/decisions.md`（ADR）を参照。
本番は Neon（`docs/deploy-vercel.md`）。以下はローカル開発環境の手順。

---

## ローカル環境：ポータブルPostgreSQL（確定構成）

GUIインストーラ（EDB）は日本語ユーザー名で失敗するため、ポータブル版 PostgreSQL **17.5** を
`C:\pgsql`（ASCIIパス）に展開して使う（trust認証＝パスワード不要）。データ領域は `C:\pgsql\data`、DB名 `pl_app`。

### サーバ起動／停止

```powershell
# 起動（停止していたら）
C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data -l C:\pgsql\log.txt start

# 接続確認
(Test-NetConnection localhost -Port 5432).TcpTestSucceeded   # → True

# 停止
C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data stop
```

### schema/seed の投入（作り直し時）

```powershell
$env:PGCLIENTENCODING='UTF8'
C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -v ON_ERROR_STOP=1 -f db\schema.sql
C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -v ON_ERROR_STOP=1 -f db\seed.sql

# 確認
C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -c "\dt"
```

**成功判定**: テーブル13個、wallets≈18 / categories≈49 / recurring_rules=10 件。

アプリの接続設定は `.env.local` の `DATABASE_URL=postgresql://postgres@localhost:5432/pl_app`。
起動は プロジェクト直下で `npm run dev`（要 DBサーバ起動済み）。

---

## 動作確認クエリ（残高が「取引から算出」される例）

各ウォレットの現在残高はこのように**集計で**算出します（残高カラムは持たない / ADR-002）。

```sql
-- ウォレット別 現在残高（初期残高 ＋ 入金脚 − 出金脚 ＋ 振替入 − 振替出）
SELECT w.name,
       w.initial_balance
       + COALESCE(SUM(CASE WHEN t.type='income'  THEN l.amount END), 0)
       - COALESCE(SUM(CASE WHEN t.type='expense' THEN l.amount END), 0)
       AS balance_from_legs
FROM wallets w
LEFT JOIN transaction_legs l ON l.wallet_id = w.id
LEFT JOIN transactions t ON t.id = l.transaction_id
WHERE w.user_id = (SELECT id FROM users WHERE email='owner@example.com')
GROUP BY w.id, w.name, w.initial_balance
ORDER BY w.name;
-- ※ transfers(振替)の加減算は別途UNIONで合算。実装はビュー/lib/queries.ts参照。
```
