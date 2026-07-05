import Link from "next/link";
import {
  getUserFyStartMonth,
  getFiscalYearPL,
  getFiscalYearTotal,
  getFyTargets,
} from "@/lib/queries";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const pad = (n: number) => String(n).padStart(2, "0");
function addMonths(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

export default async function YearPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string }>;
}) {
  await requireAuth();
  const sp = await searchParams;
  const fyStartMonth = await getUserFyStartMonth();

  // FY開始(月初日)を決定：?start 指定があればそれ、無ければ「今日が属するFY」の開始
  const now = new Date();
  let start: string;
  if (/^\d{4}-\d{2}-01$/.test(sp.start ?? "")) {
    start = sp.start as string;
  } else {
    const y = now.getMonth() + 1 >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;
    start = `${y}-${pad(fyStartMonth)}-01`;
  }
  const [sy, sm] = start.split("-").map(Number);
  const endLabel = addMonths(start, 11); // 最終月
  const [ey, em] = endLabel.split("-").map(Number);
  const fyLabel = `FY${sy}（${sy}年${sm}月〜${ey}年${em}月）`;

  const [rows, targets] = await Promise.all([getFiscalYearPL(start), getFyTargets(start)]);

  // 年間の予実対比（ADR-036）：目標が1つでも入っている場合のみセクション表示
  const tgTot = targets.reduce(
    (a, t) => ({ income: a.income + t.income, expense: a.expense + t.expense }),
    { income: 0, expense: 0 }
  );
  const hasTargets = tgTot.income > 0 || tgTot.expense > 0;

  // 複数FY比較（当年度＋過去2年度）
  const compareStarts = [addMonths(start, -24), addMonths(start, -12), start];
  const compare = await Promise.all(
    compareStarts.map(async (s) => ({ start: s, fy: Number(s.split("-")[0]), tot: await getFiscalYearTotal(s) }))
  );
  const maxCmp = Math.max(1, ...compare.map((c) => Math.abs(c.tot.surplus)));
  const tot = rows.reduce(
    (a, r) => ({
      income: a.income + r.income,
      fixed: a.fixed + r.fixed,
      variable: a.variable + r.variable,
      surplus: a.surplus + r.surplus,
    }),
    { income: 0, fixed: 0, variable: 0, surplus: 0 }
  );
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.surplus)));

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href={`/year?start=${addMonths(start, -12)}`} className="text-slate-400 hover:text-slate-900 text-lg px-1" aria-label="前年度">‹</Link>
            <h1 className="text-lg font-bold tabular-nums">{fyLabel}</h1>
            <Link href={`/year?start=${addMonths(start, 12)}`} className="text-slate-400 hover:text-slate-900 text-lg px-1" aria-label="翌年度">›</Link>
          </div>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ダッシュボード</Link>
        </header>

        {/* 年計サマリ */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="年間 収入" value={tot.income} />
          <Stat label="年間 固定費" value={tot.fixed} />
          <Stat label="年間 変動費" value={tot.variable} />
          <Stat label="年間 黒字" value={tot.surplus} accent />
        </section>

        {/* 月次テーブル */}
        <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2">月</th>
                <th className="text-right px-3 py-2">収入</th>
                <th className="text-right px-3 py-2 hidden sm:table-cell">固定費</th>
                <th className="text-right px-3 py-2 hidden sm:table-cell">変動費</th>
                <th className="text-right px-3 py-2">黒字</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.month} className="hover:bg-slate-50">
                  <td className="px-3 py-2 tabular-nums">
                    <Link href={`/?m=${r.month}-01`} className="text-sky-600 hover:underline">{r.month}</Link>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{yen(r.income)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500 hidden sm:table-cell">{yen(r.fixed)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500 hidden sm:table-cell">{yen(r.variable)}</td>
                  <td className={"px-3 py-2 text-right tabular-nums font-semibold " + (r.surplus < 0 ? "text-red-500" : "text-emerald-600")}>
                    {yen(r.surplus)}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-bold">
                <td className="px-3 py-2">年計</td>
                <td className="px-3 py-2 text-right tabular-nums">{yen(tot.income)}</td>
                <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">{yen(tot.fixed)}</td>
                <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">{yen(tot.variable)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{yen(tot.surplus)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* 黒字の月次推移（簡易バー） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">月次黒字の推移</h2>
          <div className="flex items-end gap-1 h-28">
            {rows.map((r) => {
              const h = (Math.abs(r.surplus) / maxAbs) * 100;
              return (
                <div key={r.month} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div
                    className={"w-full rounded-t " + (r.surplus < 0 ? "bg-red-300" : "bg-emerald-400")}
                    style={{ height: `${h}%` }}
                    title={`${r.month}: ${yen(r.surplus)}`}
                  />
                  <span className="text-[8px] text-slate-400 mt-1">{r.month.slice(5)}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* 年間の予実対比（ADR-036）：現運用サマリの「(FY)年間予算達成」 */}
        {hasTargets && (
          <section className="bg-white rounded-2xl shadow-sm p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-500">
                <span className="deco mr-1" aria-hidden="true">🎯</span>年間予算達成（予実対比）
              </h2>
              <Link href="/budget" className="text-[11px] text-sky-600 hover:underline">
                月次の目標を設定 →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left px-2 py-1.5">月</th>
                    {rows.map((r) => (
                      <th key={r.month} className="text-right px-2 py-1.5 tabular-nums">
                        {Number(r.month.slice(5))}月
                      </th>
                    ))}
                    <th className="text-right px-2 py-1.5">合計</th>
                    <th className="text-right px-2 py-1.5">達成率</th>
                  </tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  <tr>
                    <td className="px-2 py-1.5 text-slate-500">予算 収入</td>
                    {targets.map((t) => (
                      <td key={t.month} className="text-right px-2 py-1.5 text-slate-500">
                        {t.income ? (t.income / 10000).toFixed(0) + "万" : "—"}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1.5 text-slate-500">{yen(tgTot.income)}</td>
                    <td className="text-right px-2 py-1.5">/</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-semibold">実績 収入</td>
                    {rows.map((r) => (
                      <td key={r.month} className="text-right px-2 py-1.5">
                        {r.income ? (r.income / 10000).toFixed(0) + "万" : "—"}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1.5 font-semibold">{yen(tot.income)}</td>
                    <td className="text-right px-2 py-1.5 font-bold text-emerald-600">
                      {tgTot.income > 0 ? Math.round((tot.income / tgTot.income) * 100) + "%" : "/"}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 text-slate-500">予算 支出</td>
                    {targets.map((t) => (
                      <td key={t.month} className="text-right px-2 py-1.5 text-slate-500">
                        {t.expense ? (t.expense / 10000).toFixed(0) + "万" : "—"}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1.5 text-slate-500">{yen(tgTot.expense)}</td>
                    <td className="text-right px-2 py-1.5">/</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-semibold">実績 支出</td>
                    {rows.map((r) => (
                      <td key={r.month} className="text-right px-2 py-1.5">
                        {r.fixed + r.variable ? ((r.fixed + r.variable) / 10000).toFixed(0) + "万" : "—"}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1.5 font-semibold">{yen(tot.fixed + tot.variable)}</td>
                    <td className="text-right px-2 py-1.5 font-bold text-emerald-600">
                      {tgTot.expense > 0
                        ? Math.round(((tot.fixed + tot.variable) / tgTot.expense) * 100) + "%"
                        : "/"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-slate-400 mt-2">
              支出の達成率は「予算内に収まったか」（100%以下が良い）。金額は万円で丸め表示。
            </p>
          </section>
        )}

        {/* 複数FY比較 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">FY比較（直近3年度）</h2>
          <div className="space-y-2">
            {compare.map((c) => (
              <div key={c.start} className="text-sm">
                <div className="flex justify-between mb-0.5">
                  <span className="font-medium tabular-nums">FY{c.fy}</span>
                  <span className="tabular-nums text-slate-500">
                    収入 {yen(c.tot.income)} ・ 支出 {yen(c.tot.fixed + c.tot.variable)} ・
                    <span className={c.tot.surplus < 0 ? "text-red-500 font-semibold" : "text-emerald-600 font-semibold"}>
                      {" "}黒字 {yen(c.tot.surplus)}
                    </span>
                  </span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={(c.tot.surplus < 0 ? "bg-red-400" : "bg-emerald-400") + " h-full"}
                    style={{ width: `${(Math.abs(c.tot.surplus) / maxCmp) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <p className="text-center text-xs text-slate-400">
          FY開始月は設定値（既定4月／ADR-017）。固定費は実績（取引）ベースで集計。
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 text-center">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={"text-base font-bold tabular-nums " + (accent ? "text-emerald-600" : "")}>{yen(value)}</div>
    </div>
  );
}
