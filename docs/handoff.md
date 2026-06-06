# 引き継ぎメモ（セッション移行用）

> このファイルは、別セッション（CLI版 Claude Code 等）で作業を再開するための要約。
> **新セッションでは、まずこの handoff.md → 下記の必読docs の順に読み込んでから続行すること。**

## プロジェクト概要
個人向けPL管理・家計簿アプリ。完全手動入力で「肌感覚」を保ちつつ、企業会計レベルの
PL（手取り→固定費→変動費→月次黒字）と資産（総資産・純資産）を可視化する。
スタック: Next.js + PostgreSQL（ローカル先行 → 将来AWS）。マルチユーザー前提。

## 必読docs（この順で読む）
1. `docs/requirements.md` … 要件定義（現運用の詳細含む）
2. `docs/decisions.md` … **ADR-001〜027（全設計判断の根拠・最重要）**
3. `docs/master-data.md` … カテゴリ/口座/カード/控除/給与のマスタ
4. `docs/database-design.md` … ER設計＋全カラム定義＋検証トレース
5. `docs/development-process.md` … フェーズ管理表（現在地）
6. `docs/how-it-works.md` … （学習用）コード5層の解剖。1取引が画面→DB→画面と巡る流れの解説

## 進捗（フェーズ）
- Phase 0 要件たたき台：✅
- Phase 1 UI/UXモック（`mockup/index.html`）：✅
- Phase 2 現運用すり合わせ（ADR-001〜027）：✅
- Phase 3 基本設計（ER＋カラム定義 `db/schema.sql`）：✅（画面遷移/API一覧は未）
- Phase 4 実装：🚧 **DB稼働＋Next.js接続済み。トップで実データのPLダッシュボード表示確認（2026-06-06）**

## いま何をしているか（再開ポイント）
**✅ ローカルPostgreSQL起動 → `schema.sql`＋`seed.sql` 投入 → Next.js接続まで完了（2026-06-06 検証済み）。**

Next.js接続の状態：
- `lib/db.ts`（pg Pool）＋ `lib/queries.ts`（PL/残高/総資産/変動費ロールアップの集計関数）。
- `app/page.tsx` がサーバーコンポーネントでDBから集計し、`http://localhost:3000` に実データのダッシュボードを描画。`/api/health` でDB件数も確認可。
- 体感用デモ取引: `db/dev/demo_seed.sql`（memo LIKE 'DEMO%' で削除可）。集計クエリ集: `db/dev/queries.sql`（lib/queries.ts と同内容）。※`db/dev/` は docker-compose の自動実行対象外（schema/seedの順序を壊さないため）。
- 起動: プロジェクト直下で `npm run dev`（要 DBサーバ起動済み）。
- 学習用の `/inspect`（`app/inspect/page.tsx`）= 全テーブルの中身を閲覧するDBインスペクター（読み取り専用）。入力前後で行が増える様子を確認できる。※友人共有前にアクセス制限を検討（現状は誰でも閲覧可）。

検証結果（成功判定をすべて満たす）：
- テーブル 13個 / wallets 18（bank4・credit_card3・prepaid7・points3・cash1）
- categories 49（変動費17・固定費11・収入6・控除10・対象外5）/ recurring_rules 10 / users 1

環境（確定・日本語パス問題は解消済み）：
- ポータブルPostgreSQL **17.5** を `C:\pgsql`（ASCIIパス）に展開・初期化済み（trust認証）。
- データ領域 `C:\pgsql\data` 初期化済み。DB名 `pl_app`。
- GUIインストーラ（EDB）は日本語ユーザー名で失敗するため不使用。ポータブル版で確定。

## DBの起動／再投入手順（次セッション用）
```powershell
# サーバ起動（停止していたら）
C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data -l C:\pgsql\log.txt start
# 接続確認
(Test-NetConnection localhost -Port 5432).TcpTestSucceeded   # → True

# schema/seed を入れ直す場合（trust認証＝パスワード不要。run.ps1はRead-Hostで対話待ちするので手動推奨）
$env:PGCLIENTENCODING='UTF8'
C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -v ON_ERROR_STOP=1 -f db\schema.sql
C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -v ON_ERROR_STOP=1 -f db\seed.sql
# 確認
C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -c "\dt"
```
**成功判定**: テーブル13個、wallets≈18 / categories≈40 / recurring_rules=10 件。

## 次の一手（DBが立ち上がった後）
1. seed.sql の固定費の金額・引落カード（🔶仮置き）をユーザーの実値に差し替え。
2. Phase 3 残り：画面遷移・API一覧の基本設計。
3. Next.js プロジェクト初期化 → このDBへ接続（環境変数 DATABASE_URL）。

## 進め方のお作法（ユーザーの希望）
- **ドキュメントを正とする**（コードより先にdocs更新）。決定は必ず `docs/decisions.md` にADRで記録。
- いきなり実装せず設計を壁打ち→合意してから進める。理由を解説しながら（DB/インフラ学習中）。
- 手戻りしても「どこをどう変えたか」を追えるように。
