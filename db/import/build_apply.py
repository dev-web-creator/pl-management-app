# 生成SQL＋本番の現状から、ガード付きの適用スクリプト apply.sql を組み立てる（本番は読み取りのみ / ADR-057）
#   python db/import/build_apply.py <generated.sql> <project_dir> <out_dir>
#   → <out_dir>/import_body.sql と <out_dir>/apply.sql ができる。適用は <out_dir> で
#     psql "$NEON_DATABASE_URL" -X -q -f apply.sql（1トランザクション。件数が想定と違えば自動 ROLLBACK）
# apply.sql の中身: 取込本体（新規追加）＋ シートで値が変わった行の UPDATE ＋ シートから消えた行の DELETE
#   ＋ 目標額の UPDATE。UPDATE/DELETE は「本番の値が想定どおり」の行だけに効くガード付き。
# 実行前に必ず全テーブルの CSV バックアップを取ること（本番 PG18 / 手元 pg_dump 17 で pg_dump 不可）。
import re, sys, io, os, subprocess

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
gen_path, proj, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
CUTOFF = os.environ.get('PL_CUTOFF', '2026-12-01')

url = None
with open(os.path.join(proj, '.env.neon.local'), encoding='utf-8') as f:
    for line in f:
        if line.startswith('NEON_DATABASE_URL='):
            url = line.split('=', 1)[1].strip().strip('\'"')

def q(sql):
    env = dict(os.environ, PGCLIENTENCODING='UTF8')
    r = subprocess.run([r'C:\pgsql\bin\psql.exe', url, '-X', '-t', '-A', '-F', '\t',
                        '-c', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; ' + sql],
                       capture_output=True, text=True, encoding='utf-8', env=env)
    if r.returncode != 0: raise SystemExit('psql error: ' + r.stderr.replace(url, '<url>')[:500])
    return [l.split('\t') for l in r.stdout.splitlines() if l and l != 'SET']

unq = lambda s: s.replace("''", "'")
esc = lambda s: str(s).replace("'", "''")
S = r"((?:[^']|'')*)"
text = open(gen_path, encoding='utf-8').read()

gen_tx = {}
for m in re.finditer(r"SELECT 1, c\.id, '(expense|income)', (\d+), '([\d-]+)', '" + S + r"', '" + S +
                     r"'\nFROM categories c WHERE c\.user_id=1 AND c\.name='" + S + "'", text):
    typ, amt, dt, memo, key, cat = m.groups()
    gen_tx[unq(key)] = (typ, int(amt), dt, unq(cat))
gen_snap = {}
for m in re.finditer(r"SELECT 1, w\.id, '([\d-]+)', (-?\d+) FROM wallets w WHERE w\.user_id=1 AND w\.name='" + S + "'", text):
    d, v, w = m.groups(); gen_snap[(unq(w), d)] = int(v)
# 給与明細: period → 明細行数
gen_pay = {}
for m in re.finditer(r"VALUES \(1, '(\d{4}-\d{2}-01)'[^\n]*\n(?:.*\n){1,3}?SELECT ins\.id, v\.t, v\.n, v\.a FROM ins, \(VALUES (.*)\) AS v\(t,n,a\);", text):
    period, vals = m.groups()
    gen_pay[period] = len(re.findall(r"\('(?:allowance|deduction)',", vals))
gen_tgt = {(p, mt): int(v) for p, mt, v in re.findall(r"INSERT INTO targets \(user_id, period, metric, amount\) VALUES \(1, '([\d-]+)', '(\w+)', (-?\d+)\)", text)}

prod_tx = {r[0]: (r[1], int(r[2]), r[3], r[4]) for r in q(
    "SELECT t.client_key, t.type, t.amount, t.accrual_date, c.name FROM transactions t "
    "JOIN categories c ON c.id=t.category_id WHERE t.user_id=1 AND t.client_key LIKE 'imp:%'")}
prod_snap = {(r[0], r[1]) for r in q(
    "SELECT w.name, s.as_of_date FROM balance_snapshots s JOIN wallets w ON w.id=s.wallet_id WHERE w.user_id=1")}
prod_pay = {r[0] for r in q("SELECT period FROM payslips WHERE user_id=1")}
prod_tgt = {(r[0], r[1]): int(r[2]) for r in q("SELECT period, metric, amount FROM targets WHERE user_id=1")}

new_tx = [k for k in gen_tx if k not in prod_tx]
changed = [k for k in gen_tx if k in prod_tx and (prod_tx[k][1], prod_tx[k][2], prod_tx[k][3]) != (gen_tx[k][1], gen_tx[k][2], gen_tx[k][3])]
gone = [k for k, p in prod_tx.items() if k not in gen_tx and p[2] < CUTOFF]
new_snap = [k for k in gen_snap if k not in prod_snap]
new_pay = {p: n for p, n in gen_pay.items() if p not in prod_pay}
tgt_chg = [k for k in gen_tgt if k in prod_tgt and gen_tgt[k] != prod_tgt[k]]
tgt_new = [k for k in gen_tgt if k not in prod_tgt]

# 取込本体（BEGIN/COMMIT を外す）
body = [l for l in text.splitlines() if l.strip() not in ('BEGIN;', 'COMMIT;')]
open(os.path.join(out_dir, 'import_body.sql'), 'w', encoding='utf-8').write('\n'.join(body) + '\n')

L = []
L.append(r"\set ON_ERROR_STOP on")
L.append("BEGIN;")
L.append("SELECT count(*) AS b_tx FROM transactions WHERE user_id=1 \\gset")
L.append("SELECT count(*) AS b_snap FROM balance_snapshots WHERE user_id=1 \\gset")
L.append("SELECT count(*) AS b_pay FROM payslips WHERE user_id=1 \\gset")
L.append("SELECT count(*) AS b_items FROM payslip_items \\gset")
L.append("SELECT count(*) AS b_tgt FROM targets WHERE user_id=1 \\gset")
L.append("SELECT coalesce(max(id),0) AS b_maxid FROM transactions \\gset")
L.append("\\echo '--- import body ---'")
L.append("\\i import_body.sql")
L.append("CREATE TEMP TABLE fix_log(kind text, n int) ON COMMIT DROP;")
for k in sorted(changed):
    p, g = prod_tx[k], gen_tx[k]
    L.append(f"WITH u AS (UPDATE transactions SET amount={g[1]}, accrual_date='{g[2]}' "
             f"WHERE user_id=1 AND client_key='{esc(k)}' AND amount={p[1]} AND accrual_date='{p[2]}' RETURNING 1) "
             f"INSERT INTO fix_log SELECT 'upd', count(*) FROM u;")
for k in sorted(gone):
    p = prod_tx[k]
    L.append(f"WITH d AS (DELETE FROM transactions WHERE user_id=1 AND client_key='{esc(k)}' "
             f"AND amount={p[1]} AND accrual_date='{p[2]}' RETURNING 1) INSERT INTO fix_log SELECT 'del', count(*) FROM d;")
for (per, mt) in sorted(tgt_chg):
    L.append(f"WITH u AS (UPDATE targets SET amount={gen_tgt[(per, mt)]} WHERE user_id=1 AND period='{per}' "
             f"AND metric='{mt}' AND amount={prod_tgt[(per, mt)]} RETURNING 1) INSERT INTO fix_log SELECT 'tgt', count(*) FROM u;")
exp_tx = f":b_tx + {len(new_tx)} - {len(gone)}"
L.append("SELECT"
         f" (SELECT coalesce(sum(n),0) FROM fix_log WHERE kind='upd') = {len(changed)}"
         f" AND (SELECT coalesce(sum(n),0) FROM fix_log WHERE kind='del') = {len(gone)}"
         f" AND (SELECT coalesce(sum(n),0) FROM fix_log WHERE kind='tgt') = {len(tgt_chg)}"
         f" AND (SELECT count(*) FROM transactions WHERE user_id=1) = {exp_tx}"
         f" AND (SELECT count(*) FROM transactions WHERE user_id=1 AND id > :b_maxid) = {len(new_tx)}"
         f" AND (SELECT count(*) FROM balance_snapshots WHERE user_id=1) = :b_snap + {len(new_snap)}"
         f" AND (SELECT count(*) FROM payslips WHERE user_id=1) = :b_pay + {len(new_pay)}"
         f" AND (SELECT count(*) FROM payslip_items) = :b_items + {sum(new_pay.values())}"
         f" AND (SELECT count(*) FROM targets WHERE user_id=1) = :b_tgt + {len(tgt_new)}"
         f" AND (SELECT count(*) FROM transactions WHERE user_id=1 AND client_key LIKE 'imp:%' AND accrual_date >= '{CUTOFF}') = 0"
         " AS ok \\gset")
L.append("SELECT (SELECT count(*) FROM transactions WHERE user_id=1) AS after_tx, "
         "(SELECT count(*) FROM transactions WHERE user_id=1 AND id > :b_maxid) AS inserted_tx, "
         "(SELECT string_agg(kind||'='||n, ' ' ORDER BY kind) FROM (SELECT kind, sum(n) n FROM fix_log GROUP BY kind) s) AS fixups, "
         "(SELECT count(*) FROM balance_snapshots WHERE user_id=1) AS after_snap, "
         "(SELECT count(*) FROM payslips WHERE user_id=1) AS after_pay;")
L.append("\\echo 'before: tx=' :b_tx ' snap=' :b_snap ' pay=' :b_pay ' items=' :b_items ' tgt=' :b_tgt ' maxid=' :b_maxid")
L.append("\\if :ok")
L.append("  COMMIT;")
L.append("  \\echo 'RESULT: COMMITTED'")
L.append("\\else")
L.append("  ROLLBACK;")
L.append("  \\echo 'RESULT: ROLLED BACK (件数が想定と違うため取り消し)'")
L.append("\\endif")
open(os.path.join(out_dir, 'apply.sql'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')

print(f'expected: new_tx={len(new_tx)} changed={len(changed)} gone={len(gone)} new_snap={len(new_snap)} '
      f'new_pay={sorted(new_pay)} items={sum(new_pay.values())} tgt_changed={len(tgt_chg)} tgt_new={len(tgt_new)}')
