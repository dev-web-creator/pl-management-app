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

## 進捗（フェーズ）
- Phase 0 要件たたき台：✅
- Phase 1 UI/UXモック（`mockup/index.html`）：✅
- Phase 2 現運用すり合わせ（ADR-001〜027）：✅
- Phase 3 基本設計（ER＋カラム定義 `db/schema.sql`）：✅（画面遷移/API一覧は未）
- Phase 4 実装：🚧 **DBをローカルで動かす作業の途中**

## いま何をしているか（再開ポイント）
**ローカルPostgreSQLを立ち上げて `db/schema.sql`＋`db/seed.sql` を流す作業の途中。**

経緯と注意：
- ユーザーのWindowsユーザー名が日本語（`C:\Users\吉岡リクルゴス`）。
- このため **EDBのGUIインストーラが `getlocales.ps1` で "Illegal characters in path" エラーになり使えない**。
  TEMPをC:\Tempに変えても、管理者昇格時に戻されてダメだった。
- → **GUIインストーラは断念。ポータブル版（ZIPバイナリ）で構築する方針に切替済み。**
- ポータブルZIPの一部DLが途中で壊れた（267MBで中断）。**再ダウンロードから再開**する。

## 再開手順（ポータブルPostgreSQL）
すべてASCIIパス（`C:\Temp`, `C:\pgsql`）で行う（日本語パス回避）。

```powershell
# 1) バイナリZIPをDL（完全に落ちるまで。壊れたら再実行）
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Invoke-WebRequest 'https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip' -OutFile 'C:\Temp\pg-binaries.zip' -UseBasicParsing
# 検証：壊れていないか（OpenReadが成功すればOK）
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead('C:\Temp\pg-binaries.zip').Entries.Count

# 2) 展開（C:\ に展開すると C:\pgsql\bin ... ができる）
Expand-Archive 'C:\Temp\pg-binaries.zip' -DestinationPath 'C:\' -Force

# 3) DB初期化（trust認証＝ローカルはパスワード不要 / UTF8）
C:\pgsql\bin\initdb.exe -D C:\pgsql\data -U postgres -A trust -E UTF8 --locale=C

# 4) サーバ起動（ポート5432）
C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data -l C:\pgsql\log.txt start

# 5) schema＋seed 投入（用意済みスクリプト。psqlはC:\pgsql\binも自動探索する）
.\db\run.ps1     # パスワードは空Enterでよい（trust認証）
#   もしくは手動:
#   C:\pgsql\bin\psql.exe -U postgres -h localhost -c "CREATE DATABASE pl_app;"
#   $env:PGCLIENTENCODING='UTF8'
#   C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -f db\schema.sql
#   C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -f db\seed.sql
#   C:\pgsql\bin\psql.exe -U postgres -h localhost -d pl_app -c "\dt"
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
