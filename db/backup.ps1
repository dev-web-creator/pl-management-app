# ローカルDBのバックアップを取り、「本当に戻せるか」まで確認する。
#   実行:  powershell -ExecutionPolicy Bypass -File db\backup.ps1
#
# 取っただけで復元できないバックアップが最も多い事故なので、
# 既定で復元テスト（別DBへのリストア）まで行う。-SkipVerify で省略可。
param(
  [string]$Db = "pl_app",
  [string]$PgBin = "C:\pgsql\bin",
  [switch]$SkipVerify
)
$ErrorActionPreference = "Stop"
$env:PGCLIENTENCODING = "UTF8"

$root    = Split-Path -Parent $PSScriptRoot
$outDir  = Join-Path $root "backups"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$file  = Join-Path $outDir "${Db}_$stamp.dump"
$conn  = "postgresql://postgres@localhost:5432/$Db"

Write-Host "[1/3] $Db をバックアップ中..."
& "$PgBin\pg_dump.exe" -Fc -d $conn -f $file
$sizeKb = [math]::Round((Get-Item $file).Length / 1KB, 1)
Write-Host "      -> $file ($sizeKb KB)"

$rows = & "$PgBin\psql.exe" $conn -t -A -c "select count(*) from transactions"
Write-Host "      -> 取引 $($rows.Trim()) 件"

if ($SkipVerify) { Write-Host "[2/3] 復元テストはスキップしました"; exit 0 }

Write-Host "[2/3] 復元テスト中（別DBへリストア）..."
$testDb = "${Db}_restorecheck"
& "$PgBin\psql.exe" "postgresql://postgres@localhost:5432/postgres" -q `
  -c "DROP DATABASE IF EXISTS $testDb;" -c "CREATE DATABASE $testDb;"
& "$PgBin\pg_restore.exe" -d "postgresql://postgres@localhost:5432/$testDb" $file 2>$null

$restored = & "$PgBin\psql.exe" "postgresql://postgres@localhost:5432/$testDb" -t -A -c "select count(*) from transactions"
& "$PgBin\psql.exe" "postgresql://postgres@localhost:5432/postgres" -q -c "DROP DATABASE IF EXISTS $testDb;"

Write-Host "[3/3] 検証結果"
if ($rows.Trim() -eq $restored.Trim()) {
  Write-Host "      OK: $($restored.Trim()) 件が復元できました。このバックアップは使えます。" -ForegroundColor Green
} else {
  Write-Host "      NG: 元 $($rows.Trim()) 件 / 復元 $($restored.Trim()) 件。一致しません。" -ForegroundColor Red
  exit 1
}

# 古いバックアップの整理（最新10件を残す）
Get-ChildItem $outDir -Filter "${Db}_*.dump" |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 |
  ForEach-Object { Remove-Item $_.FullName; Write-Host "      古いバックアップを削除: $($_.Name)" }
