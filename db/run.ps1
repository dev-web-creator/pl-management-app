# ============================================================
#  PostgreSQL に schema.sql / seed.sql を流す実行スクリプト
#  使い方: プロジェクト直下の PowerShell で  .\db\run.ps1
#  前提: PostgreSQL をインストール済み（postgresユーザーのパスワードを控えておく）
# ============================================================
$ErrorActionPreference = 'Stop'

# 1) psql.exe を自動で探す（PATHに無くてもOK）
#    インストーラ版(Program Files) と ポータブル版(C:\pgsql\bin) の両方を探索
$candidates = @()
$candidates += Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue
$candidates += Get-ChildItem 'C:\pgsql\bin\psql.exe' -ErrorAction SilentlyContinue
$psql = $candidates | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $psql) {
  Write-Host 'psql.exe が見つかりません。PostgreSQL（C:\pgsql\bin など）を確認してください。' -ForegroundColor Red
  exit 1
}
Write-Host "使用する psql: $psql" -ForegroundColor Cyan

# 2) 日本語が化けないよう UTF-8 を明示
$env:PGCLIENTENCODING = 'UTF8'

# 3) パスワードを一度だけ安全に入力（画面に表示されない）
#    ※ポータブル版(trust認証)ならパスワード不要 → そのまま空Enterでよい
$sec = Read-Host 'postgres のパスワード（ポータブル版なら空Enter）' -AsSecureString
$env:PGPASSWORD = (New-Object System.Net.NetworkCredential('', $sec)).Password

try {
  # 4) データベース pl_app を作成（既にあればスキップ）
  Write-Host 'データベース pl_app を作成中...' -ForegroundColor Cyan
  & $psql -U postgres -h localhost -p 5432 -c 'CREATE DATABASE pl_app;' 2>$null

  # 5) スキーマ → 初期データ の順に実行（エラーが出たら即停止）
  Write-Host 'schema.sql を実行中...' -ForegroundColor Cyan
  & $psql -U postgres -h localhost -p 5432 -d pl_app -v ON_ERROR_STOP=1 -f "$PSScriptRoot\schema.sql"
  Write-Host 'seed.sql を実行中...' -ForegroundColor Cyan
  & $psql -U postgres -h localhost -p 5432 -d pl_app -v ON_ERROR_STOP=1 -f "$PSScriptRoot\seed.sql"

  # 6) 確認：テーブル一覧 ＋ 件数
  Write-Host "`n=== テーブル一覧（13個出ればOK）===" -ForegroundColor Green
  & $psql -U postgres -h localhost -p 5432 -d pl_app -c '\dt'
  Write-Host "`n=== 投入件数の確認 ===" -ForegroundColor Green
  & $psql -U postgres -h localhost -p 5432 -d pl_app -c `
    "SELECT 'wallets' AS table, count(*) FROM wallets UNION ALL SELECT 'categories', count(*) FROM categories UNION ALL SELECT 'recurring_rules', count(*) FROM recurring_rules;"
  Write-Host "`n完了！" -ForegroundColor Green
}
finally {
  # 7) パスワードを環境変数から消す（後始末）
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
