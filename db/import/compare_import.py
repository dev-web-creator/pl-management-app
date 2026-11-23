# 生成した import SQL と本番DBを突き合わせる（本番は読み取りのみ / ADR-057）
#   python db/import/compare_import.py <generated.sql> <project_dir>
# 本番の接続文字列は <project_dir>/.env.neon.local の NEON_DATABASE_URL から読む（git管理外）。
# 出力: [1]新規に入る行 [2]シートで値が変わった既存行 [3]シートから消えた行 [4]残高 [5]給与明細・目標
# gen_import.py は ON CONFLICT DO NOTHING なので、[2][3] は取込だけでは反映されない → build_apply.py で処理する。
import re, sys, io, os, subprocess
from collections import defaultdict, Counter

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
gen_path, proj = sys.argv[1], sys.argv[2]
CUTOFF = os.environ.get('PL_CUTOFF', '2026-12-01')

url = None
with open(os.path.join(proj, '.env.neon.local'), encoding='utf-8') as f:
    for line in f:
        if line.startswith('NEON_DATABASE_URL='):
            url = line.split('=', 1)[1].strip().strip('\'"')
assert url and url.startswith(('postgresql://', 'postgres://')), 'bad url'

def q(sql):
    env = dict(os.environ, PGCLIENTENCODING='UTF8')
    r = subprocess.run([r'C:\pgsql\bin\psql.exe', url, '-X', '-t', '-A', '-F', '\t',
                        '-c', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; ' + sql],
                       capture_output=True, text=True, encoding='utf-8', env=env)
    if r.returncode != 0:
        raise SystemExit('psql error: ' + r.stderr.replace(url, '<url>')[:500])
    return [l.split('\t') for l in r.stdout.splitlines() if l and l != 'SET']

unq = lambda s: s.replace("''", "'")
S = r"((?:[^']|'')*)"
text = open(gen_path, encoding='utf-8').read()

# ---- generated ----
gen_tx = {}
for m in re.finditer(r"SELECT 1, c\.id, '(expense|income)', (\d+), '([\d-]+)', '" + S + r"', '" + S +
                     r"'\nFROM categories c WHERE c\.user_id=1 AND c\.name='" + S + "'", text):
    typ, amt, dt, memo, key, cat = m.groups()
    gen_tx[unq(key)] = (typ, int(amt), dt, unq(cat))
gen_snap = {}
for m in re.finditer(r"SELECT 1, w\.id, '([\d-]+)', (-?\d+) FROM wallets w WHERE w\.user_id=1 AND w\.name='" + S + "'", text):
    d, v, w = m.groups(); gen_snap[(unq(w), d)] = int(v)
gen_pay = set(re.findall(r"INSERT INTO payslips \([^)]*\)\s*VALUES \(1, '(\d{4}-\d{2}-01)'", text))
gen_tgt = {(p, mt): int(v) for p, mt, v in re.findall(r"INSERT INTO targets \(user_id, period, metric, amount\) VALUES \(1, '([\d-]+)', '(\w+)', (-?\d+)\)", text)}
gen_newcats = re.findall(r"SELECT 1, [^,]+, '" + S + r"', '(\w+)', (true|false), 900", text)

# ---- production ----
prod_tx = {r[0]: (r[1], int(r[2]), r[3], r[4]) for r in q(
    "SELECT t.client_key, t.type, t.amount, t.accrual_date, c.name FROM transactions t "
    "JOIN categories c ON c.id=t.category_id WHERE t.user_id=1 AND t.client_key LIKE 'imp:%'")}
prod_cats = {r[0] for r in q("SELECT name FROM categories WHERE user_id=1")}
prod_wallets = {r[0] for r in q("SELECT name FROM wallets WHERE user_id=1")}
prod_snap = {(r[0], r[1]): int(r[2]) for r in q(
    "SELECT w.name, s.as_of_date, s.actual_balance FROM balance_snapshots s JOIN wallets w ON w.id=s.wallet_id WHERE w.user_id=1")}
prod_pay = {r[0] for r in q("SELECT period FROM payslips WHERE user_id=1")}
prod_tgt = {(r[0], r[1]): int(r[2]) for r in q("SELECT period, metric, amount FROM targets WHERE user_id=1")}

print(f'generated: tx={len(gen_tx)} snap={len(gen_snap)} payslip={len(gen_pay)} target={len(gen_tgt)}')
print(f'prod     : imp tx={len(prod_tx)} snap={len(prod_snap)} payslip={len(prod_pay)} target={len(prod_tgt)}')

# 0) 参照先の存在（無いと INSERT...SELECT が0件になり黙って欠落する）
missing_cats = sorted({v[3] for v in gen_tx.values()} - prod_cats - {unq(n) for n, *_ in gen_newcats})
missing_wal = sorted({w for w, _ in gen_snap} - prod_wallets - {'bitFlyer ETH', 'bitFlyer BTC', 'bitFlyer XRP'})
print('\n[0] 本番に無いカテゴリ:', missing_cats or 'なし', '/ 本番に無いウォレット:', missing_wal or 'なし')

# 1) 新規に入る取引
new = [k for k in gen_tx if k not in prod_tx]
by = defaultdict(lambda: [0, 0])
for k in new:
    typ, amt, dt, cat = gen_tx[k]
    b = by[(dt[:7], k.split(':')[1], typ)]; b[0] += 1; b[1] += amt
print(f'\n[1] 新規に入る取引: {len(new)}件')
for (mo, src, typ), (n, amt) in sorted(by.items()):
    print(f'   {mo} {src:3} {typ:7} {n:4}件 {amt:>10,}円')

# 2) シート側で変わった既存行（DO NOTHING なので更新されない）
changed = [(k, prod_tx[k], gen_tx[k]) for k in gen_tx if k in prod_tx and
           (prod_tx[k][1] != gen_tx[k][1] or prod_tx[k][2] != gen_tx[k][2] or prod_tx[k][3] != gen_tx[k][3])]
print(f'\n[2] 既に入っていて、シートで金額等が変わった行: {len(changed)}件')
for k, p, g in sorted(changed, key=lambda x: x[0])[:40]:
    print(f'   {k}: 本番 {p[2]} {p[3]} {p[1]:,} → シート {g[2]} {g[3]} {g[1]:,}')

# 3) 本番にあるがシートから消えた取込行（カットオフ前のみ）
gone = [k for k, p in prod_tx.items() if k not in gen_tx and p[2] < CUTOFF]
print(f'\n[3] 本番にあるがシート側に無い取込行: {len(gone)}件')
for k in sorted(gone)[:40]:
    p = prod_tx[k]; print(f'   {k}: {p[2]} {p[3]} {p[1]:,}')

# 4) 残高スナップショット
sn_new = sorted(k for k in gen_snap if k not in prod_snap)
sn_chg = sorted(k for k in gen_snap if k in prod_snap and gen_snap[k] != prod_snap[k])
print(f'\n[4] 残高: 新規 {len(sn_new)}件 / 値が変わった既存 {len(sn_chg)}件')
print('   新規の月:', dict(sorted(Counter(d[:7] for _, d in sn_new).items())))
for k in sn_chg[:20]: print(f'   変更 {k[0]} {k[1]}: 本番 {prod_snap[k]:,} → シート {gen_snap[k]:,}')

# 5) 給与明細・目標
print(f'\n[5] 給与明細: 新規 {sorted(gen_pay - prod_pay)}')
tg_new = sorted(k for k in gen_tgt if k not in prod_tgt)
tg_chg = sorted(k for k in gen_tgt if k in prod_tgt and gen_tgt[k] != prod_tgt[k])
print(f'   目標: 新規 {tg_new} / 値が変わった既存 {[(k, prod_tgt[k], gen_tgt[k]) for k in tg_chg]}')
