# 無料枠クラウドへのデプロイ手順（Neon + Vercel）

> 目的：今のローカルアプリ（Next.js + PostgreSQL）を、コードを変えずに無料枠クラウドへ載せ、
> **PC・スマホの両方から同じデータで使える**状態にする。
> 構成：**Vercel**（アプリのホスティング・無料Hobby）＋ **Neon**（サーバーレスPostgreSQL・無料枠）。

## なぜこの2つか
- **Neon**：純粋なサーバーレスPostgreSQL。無料枠＆未使用時は自動スリープ＝**$0**。
  ローカルと同じPostgreSQLなので `db/schema.sql`/`seed.sql` がそのまま使える。将来のRDS/Auroraの良い予習。
- **Vercel**：Next.jsの開発元。GitHubに繋ぐだけで自動ビルド・HTTPS付きURL・自動デプロイ。

## 役割分担
- 🧑 あなた：アカウント作成・認証（Neon / Vercel / GitHub）。3つの値を私に渡す or 画面で設定。
- 🤖 私：コード準備（完了）・Neonへのスキーマ/初期データ投入・設定の指示。

---

## 事前の重要事項（家計データなので必読）
- **GitHubリポジトリは「Private（非公開）」推奨**。家計の費目・口座名・金額が入るため。
- `/inspect`（DB全閲覧ページ）は**誰でも見られる**ので、公開前にアクセス制限 or 本番では無効化する（下記 手順5）。
- 接続情報（DATABASE_URL）は**Vercelの環境変数 + Neon側のみ**に置き、Gitには絶対入れない（`.env.local`はignore済み）。

---

## 手順

### 1. Neon でDBを作る（あなた・約3分）
1. https://neon.tech にサインアップ（GitHubアカウントでログイン可）。
2. 「Create project」→ リージョンは近い所（例：Singapore `ap-southeast-1` 等）。
3. 作成後の **Connection string** をコピー（`postgresql://...neon.tech/neondb?sslmode=require` の形）。
4. → この文字列を私に渡してください（または自分で手順2を実行）。

### 2. Neon にスキーマ＋初期データを投入（私が実行 / あなたでも可）
```powershell
$env:PGCLIENTENCODING='UTF8'
$NEON='postgresql://<コピーした接続文字列>'   # sslmode=require 付き
C:\pgsql\bin\psql.exe "$NEON" -v ON_ERROR_STOP=1 -f db\schema.sql
C:\pgsql\bin\psql.exe "$NEON" -v ON_ERROR_STOP=1 -f db\seed.sql
C:\pgsql\bin\psql.exe "$NEON" -c "\dt"   # 13テーブル確認
```
> ローカルと同じSQLがそのままクラウドのDBに通る ＝「接続先が変わるだけ」の実証。

### 3. GitHub に最新コードを push（あなた／認証要）
```powershell
# リポジトリが Private であることを確認してから
git push -u origin master
```
> 既に `origin = lycourgosyoshioka-crypto/pl-management-app` が設定済み。

### 4. Vercel にデプロイ（あなた・約3分）
1. https://vercel.com に GitHub でログイン。
2. 「Add New… → Project」→ `pl-management-app` を Import。
3. **Environment Variables** に追加：
   - `DATABASE_URL` = Neonの接続文字列（手順1の値）
4. 「Deploy」を押す → 数分で `https://pl-management-app-xxxx.vercel.app` が発行される。
5. 以降、`git push` するたびに自動で再デプロイされる。

### 5. 公開前の最低限の保護（共有フェーズで必須）
- `/inspect` を本番で塞ぐ（環境変数で出し分け、Basic認証、または削除）。
- 友人共有時は「マルチユーザー化（ログイン）」が必要（今は単一ユーザー固定）。MVPの次の課題。

---

## うまく動かない時のチェック
- 画面は出るが数字が0 → Neonにseedが入っていない（手順2を再確認）。
- DB接続エラー → Vercelの `DATABASE_URL` の綴り、末尾の `?sslmode=require` の有無。
- ビルド失敗 → ローカルで `npm run build` が通るかを先に確認（確認済み）。

---

## この作業で学べること（c=AWSへの布石）
- **マネージドDB**（Neon）＝ RDS/Aurora の概念の入り口。
- **接続文字列の差し替えだけで接続先が変わる**＝デプロイの本質。
- **環境変数でシークレット管理**＝Secrets Manager（AWS）に繋がる考え方。
- **GitHub push→自動デプロイ（CI/CD）**＝本番運用の基本動作。
