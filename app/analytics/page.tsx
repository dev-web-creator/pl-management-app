import Link from "next/link";
import { getMonthlySeries, getCategoryMoM } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const pad = (n: number) => String(n).padStart(2, "0");

// テーマ色
const C_INCOME = "#3f9d76";
const C_EXPENSE = "#e2724f";
const C_SURPLUS = "#2f92b8";

export default async function AnalyticsPage() {
  await requireAuth();
  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;

  const [series, cats] = await Promise.all([getMonthlySeries(12), getCategoryMoM(thisMonthKey)]);

  const cur = series[series.length - 1];
  const prior = series.slice(0, -1).filter((s) => s.income || s.expense); // データのある過去月だけで平均
  const avg = (sel: (m: (typeof series)[number]) => number) =>
    prior.length ? Math.round(prior.reduce((a, m) => a + sel(m), 0) / prior.length) : 0;
  const avgIncome = avg((m) => m.income);
  const avgExpense = avg((m) => m.expense);
  const avgSurplus = avg((m) => m.surplus);

  const max = Math.max(1, ...series.flatMap((s) => [s.income, s.expense]));

  // SVG 寸法
  const W = 720;
  const H = 240;
  const padX = 30;
  const padY = 22;
  const base = H - padY;
  const chartH = H - padY * 2;
  const gw = (W - padX * 2) / series.length;
  const barW = gw * 0.28;
  const surplusPts = series
    .map((s, i) => {
      const cx = padX + i * gw + gw * 0.5;
      const ratio = Math.max(0, Math.min(1, s.surplus / max));
      const cy = base - ratio * chartH;
      return `${cx},${cy}`;
    })
    .join(" ");

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">📊 分析</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ダッシュボード</Link>
        </header>

        {/* 今月 vs 直近平均 */}
        <section className="grid grid-cols-3 gap-3">
          <CompareCard label="収入" now={cur?.income ?? 0} avg={avgIncome} color={C_INCOME} goodWhenUp />
          <CompareCard label="支出" now={cur?.expense ?? 0} avg={avgExpense} color={C_EXPENSE} goodWhenUp={false} />
          <CompareCard label="黒字" now={cur?.surplus ?? 0} avg={avgSurplus} color={C_SURPLUS} goodWhenUp />
        </section>

        {/* 月次推移（収入・支出・黒字） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-500">収入・支出・黒字の推移（12ヶ月）</h2>
            <div className="flex items-center gap-3 text-[10px] text-slate-500">
              <Legend color={C_INCOME} label="収入" />
              <Legend color={C_EXPENSE} label="支出" />
              <Legend color={C_SURPLUS} label="黒字" line />
            </div>
          </div>
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 560 }}>
              {series.map((s, i) => {
                const gx = padX + i * gw;
                const incH = (s.income / max) * chartH;
                const expH = (s.expense / max) * chartH;
                return (
                  <g key={s.month}>
                    <rect x={gx + gw * 0.18} y={base - incH} width={barW} height={Math.max(0, incH)} rx={2} fill={C_INCOME} />
                    <rect x={gx + gw * 0.52} y={base - expH} width={barW} height={Math.max(0, expH)} rx={2} fill={C_EXPENSE} />
                    <text x={gx + gw * 0.5} y={H - 5} textAnchor="middle" fontSize="8" fill="#93a89b">
                      {s.month.slice(2)}
                    </text>
                  </g>
                );
              })}
              {/* 黒字ライン */}
              <polyline points={surplusPts} fill="none" stroke={C_SURPLUS} strokeWidth={2} strokeLinejoin="round" />
              {series.map((s, i) => {
                const cx = padX + i * gw + gw * 0.5;
                const ratio = Math.max(0, Math.min(1, s.surplus / max));
                return <circle key={s.month} cx={cx} cy={base - ratio * chartH} r={2.5} fill={C_SURPLUS} />;
              })}
            </svg>
          </div>
        </section>

        {/* 支出カテゴリ 今月トップ＋前月比 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">支出カテゴリ 今月トップ（前月比）</h2>
          {cats.length === 0 ? (
            <p className="text-sm text-slate-400">今月・前月の支出データがありません。</p>
          ) : (
            <div className="space-y-1.5">
              {cats.map((c) => {
                const diff = c.this_month - c.last_month;
                return (
                  <div key={c.name} className="flex items-center justify-between text-sm">
                    <span className="truncate">{c.name}</span>
                    <span className="flex items-center gap-3 tabular-nums shrink-0">
                      <span className="font-semibold">{yen(c.this_month)}</span>
                      <span
                        className={
                          "text-[11px] w-24 text-right " +
                          (diff > 0 ? "text-red-500" : diff < 0 ? "text-emerald-600" : "text-slate-400")
                        }
                      >
                        前月比 {diff > 0 ? "+" : diff < 0 ? "−" : "±"}
                        {yen(Math.abs(diff))}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <p className="text-center text-xs text-slate-400">
          月次はサーバーの「今月」を起点に直近12ヶ月。支出＝固定費＋変動費。すべて取引から集計。
        </p>
      </div>
    </main>
  );
}

function CompareCard({
  label,
  now,
  avg,
  color,
  goodWhenUp,
}: {
  label: string;
  now: number;
  avg: number;
  color: string;
  goodWhenUp: boolean;
}) {
  const diff = now - avg;
  const pct = avg !== 0 ? Math.round((diff / Math.abs(avg)) * 100) : null;
  const up = diff >= 0;
  const good = up === goodWhenUp;
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4">
      <div className="text-[10px] font-semibold tracking-wider text-slate-500">{label}（今月）</div>
      <div className="mt-1 text-lg font-extrabold tabular-nums" style={{ color }}>
        ¥{now.toLocaleString("ja-JP")}
      </div>
      <div className={"mt-1 text-[11px] tabular-nums " + (good ? "text-emerald-600" : "text-red-500")}>
        直近平均比 {up ? "+" : "−"}
        {Math.abs(diff).toLocaleString("ja-JP")}
        {pct != null && <span className="ml-1">({up ? "+" : ""}{pct}%)</span>}
      </div>
    </div>
  );
}

function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block"
        style={{
          width: 10,
          height: line ? 2 : 10,
          borderRadius: line ? 0 : 2,
          background: color,
        }}
      />
      {label}
    </span>
  );
}
