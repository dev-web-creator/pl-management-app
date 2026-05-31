# データベースのセットアップと検証

このディレクトリのSQL：
- `schema.sql` … テーブル定義（DDL）。13テーブル＋トリガ。
- `seed.sql` … 初期データ（ウォレット・カテゴリ・固定費マスタ等）。`schema.sql`の後に実行。

設計の根拠は `../docs/database-design.md` と `../docs/decisions.md`（ADR）を参照。

---

## 方法A：Docker で立ち上げる（おすすめ・最短）

[Docker Desktop](https://www.docker.com/products/docker-desktop/) を入れて、プロジェクト直下で：

```bash
docker compose up -d
```

初回起動で `schema.sql` → `seed.sql` が**自動実行**されます。中身を確認：

```bash
# テーブル一覧
docker exec -it pl_app_db psql -U pl -d pl_app -c "\dt"

# カテゴリのツリーが入ったか
docker exec -it pl_app_db psql -U pl -d pl_app -c "SELECT name, pl_type, is_input_allowed FROM categories ORDER BY display_order;"

# ウォレット
docker exec -it pl_app_db psql -U pl -d pl_app -c "SELECT name, type, branch FROM wallets ORDER BY display_order;"
```

作り直したいとき：

```bash
docker compose down -v   # データ削除
docker compose up -d     # schema/seed を再実行
```

---

## 方法B：PostgreSQL を直接インストール

Windows は [PostgreSQL公式インストーラ](https://www.postgresql.org/download/windows/) を導入後：

```bash
# DB作成
createdb pl_app

# スキーマ→初期データ
psql -d pl_app -f db/schema.sql
psql -d pl_app -f db/seed.sql
```

---

## 動作確認クエリ（残高が「取引から算出」される例）

将来、取引(transactions/transaction_legs)や振替(transfers)を入れた後、
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
-- ※ transfers(振替)の加減算は別途UNIONで合算。実装時にビュー化する。
```
