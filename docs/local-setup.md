# ローカル開発環境セットアップ（初心者向け詳細ガイド）

私たちが書いた `db/schema.sql` は「こういうテーブルを作れ」という**指示書**。
それを実行する**データベース本体（PostgreSQL）**を用意する必要がある。
ここでは一番ラクな **Docker** を使う手順を細かく説明する。

## 用語ミニ辞典
| 用語 | 役割 |
|------|------|
| PostgreSQL | データを保管・管理する本体プログラム（倉庫そのもの）|
| psql | PostgreSQLに命令を送る操作端末（受付窓口）|
| Docker | ソフトを「箱詰め完成品（コンテナ）」で動かす仕組み |
| Docker Desktop | WindowsでDockerを動かすためのアプリ |
| docker-compose.yml | 起動レシピ（このプロジェクトに用意済み）|
| image / container | image=設計図、container=そこから起動した実体 |

---

## 手順（Windows）

### STEP 1. Docker Desktop をインストール
1. https://www.docker.com/products/docker-desktop/ から「Download for Windows」。
2. ダウンロードした `Docker Desktop Installer.exe` を実行。基本「OK / Next」でOK。
   - 途中で「WSL2を有効化」と出たら有効化（Dockerが内部で使うLinux環境。インストーラが面倒を見てくれる）。
3. 完了後、**PCを再起動**（求められたら）。

### STEP 2. Docker Desktop を起動
1. スタートメニューから「Docker Desktop」を起動。
2. 右下／タスクトレイの**クジラのアイコン**が安定し、アプリ画面が "Engine running" になるまで待つ（初回は数分）。
   - ※ Docker Desktop を起動していない間は docker コマンドは使えない。

### STEP 3. ターミナルでプロジェクトへ移動して起動
PowerShell を開き、プロジェクト直下（`docker-compose.yml` がある場所）で：

```powershell
docker --version          # 例: Docker version 27.x → 入っていればOK
docker compose up -d      # DB起動（初回はimageを自動ダウンロード→schema→seedを自動実行）
```

- 初回は PostgreSQL の image（約150MB）をダウンロードするので少し待つ。
- `-d` は「バックグラウンドで動かす」の意味。

### STEP 4. ちゃんとできたか確認
```powershell
docker compose ps                     # status が running/healthy ならOK
docker compose logs db                # 初期化ログ（schema/seed実行）を確認

# テーブル一覧（13個出ればOK）
docker exec -it pl_app_db psql -U pl -d pl_app -c "\dt"

# カテゴリのツリーが入ったか
docker exec -it pl_app_db psql -U pl -d pl_app -c "SELECT name, pl_type, is_input_allowed FROM categories ORDER BY display_order;"

# ウォレット
docker exec -it pl_app_db psql -U pl -d pl_app -c "SELECT name, type, branch FROM wallets ORDER BY display_order;"
```
> `docker exec -it pl_app_db psql ...` は「起動中のコンテナ(pl_app_db)の中にあるpsqlを使って命令する」という意味。
> psqlを別途インストールしなくても、コンテナの中のpsqlを借りられる。

### STEP 5. 止める・作り直す
```powershell
docker compose down       # 止める（データは残る）
docker compose up -d       # また起動
docker compose down -v     # データごと完全削除（schema/seedを最初からやり直したいとき）
```
> seed.sql を直したら `down -v` → `up -d` で作り直すと反映される
> （初期化SQLは「データが空のとき」だけ自動実行されるため）。

---

## つまずきポイント
- **`cannot connect to the Docker daemon`** … Docker Desktop が起動していない。STEP2をやり直す。
- **`port 5432 ... already in use`** … 既に別のPostgreSQLが5432番を使用中。`docker-compose.yml` の
  `"5432:5432"` を `"5433:5432"` などに変更（左がPC側のポート）。
- **日本語が文字化け** … 通常は問題なし（UTF-8）。PowerShellの表示の問題なら別ターミナルでも確認可。

---

## 方法B：PostgreSQL を直接インストール（本プロジェクトの採用方法）

Docker Desktop は大企業での業務利用に有料ライセンスが要るため、本プロジェクトでは
オープンソースで制限のない PostgreSQL を直接入れる。

### STEP 1. インストーラを入手
https://www.postgresql.org/download/windows/ →「Download the installer」→
EDB のインストーラ（最新の安定版、例: PostgreSQL 17）をダウンロード。

### STEP 2. インストール
`postgresql-XX-windows-x64.exe` を実行。基本「Next」でOK。途中のポイントだけ：
- **Select Components**: PostgreSQL Server / Command Line Tools / pgAdmin 4 はチェックON。
  「Stack Builder」はチェックOFFでよい。
- **Data Directory**: デフォルトのまま。
- **Password**: `postgres`（管理ユーザー）のパスワードを設定。**必ず控える**（後で使う）。
- **Port**: `5432`（デフォルト）。
- **Locale**: `Default locale` のまま。
- 完了。Stack Builder が開いたら閉じてOK。

### STEP 3. schema / seed を流す（用意したスクリプトで一発）
プロジェクト直下の PowerShell で：
```powershell
.\db\run.ps1
```
- `postgres` のパスワードを聞かれたら、STEP2で設定したものを入力（画面には表示されない）。
- スクリプトが「DB作成 → schema.sql → seed.sql → テーブル一覧＆件数」まで自動実行する。
- **テーブルが13個**並び、wallets≈18 / categories≈40 / recurring_rules=10 件と出れば成功。

> `run.ps1` は psql.exe の場所を自動で探すので、PATH 設定は不要。
> 作り直したいとき: `psql -U postgres -c "DROP DATABASE pl_app;"` 後にもう一度 `.\db\run.ps1`。
> （schema.sql 冒頭で各テーブルを DROP しているので、DB を消さず `.\db\run.ps1` 再実行でも作り直せる）

### 手動で実行したい場合（中身を理解したい人向け）
```powershell
# psql が PATH に無ければ、まずこのセッションだけ通す（バージョンは適宜）
$env:Path += ';C:\Program Files\PostgreSQL\17\bin'
$env:PGCLIENTENCODING = 'UTF8'

psql -U postgres -c "CREATE DATABASE pl_app;"
psql -U postgres -d pl_app -f db\schema.sql
psql -U postgres -d pl_app -f db\seed.sql
psql -U postgres -d pl_app -c "\dt"
```
