import Link from "next/link";
import { getForecastInputs } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const man = (n: number) => (n / 10000).toFixed(0) + "万";
const pad = (n: number) => String(n).padStart(2, "0");

// テーマ色
const C_ASSET = "#2f92b8";
const C_SURPLUS_POS = "#3f9d76";
const C_SURPLUS_NEG = "#e2724f";

type MonthRow = {
  key: string; // 'YYYY-MM'
  income: number;
  expense: number;
  surplus: number;
  isActual: boolean;
  assets: number; // 月末想定純資産
};

// 5か年PL（ADR-044）：実績月＝取引の実額 / 未来月＝目標（targets）優先、
// 無ければ 固定費マスタ＋直近6ヶ月平均（変動費・収入）で自動見込み。
export default async function ForecastPage() {
  await requireAuth();
  const { fyStartMonth, actuals, targets, rules, netAssets } = await getForecastInputs();

  const now = new Date();
  const curKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  // 当FYの開始月（今月を含むFY）
  let fyStartYear = now.getFullYear();
  if (now.getMonth() + 1 < fyStartMonth) fyStartYear -= 1;

  const actualMap = new Map(actuals.map((a) => [a.month, a]));
  const targetMap = new Map<string, { income?: number; expense?: number }>();
  for (const t of targets) {
    const e = targetMap.get(t.period) ?? {};
    if (t.metric === "income") e.income = t.amount;
    if (t.metric === "expense") e.expense = t.amount;
    targetMap.set(t.period, e);
  }

  // 直近6ヶ月（今月を除く完了月）の平均：収入・変動費
  const done = actuals.filter((a) => a.month < curKey).slice(-6);
  const avg = (sel: (a: (typeof actuals)[number]) => number) =>
    done.length ? Math.round(done.reduce((s, a) => s + sel(a), 0) / done.length) : 0;
  const avgIncome = avg((a) => a.income);
  const avgVariable = avg((a) => a.variable);

  // その月に有効な月額固定費の合計（ADR-030のアクティブ判定と同じ）
  const fixedPlan = (key: string) =>
    rules
      .filter((r) => r.start_month <= key && (r.end_month === null || r.end_month > key))
      .reduce((s, r) => s + r.amount, 0);

  // 60ヶ月を構築
  const months: MonthRow[] = [];
  let assets = netAssets; // 現在の純資産を起点に未来へ積む
  for (let i = 0; i < 60; i++) {
    const y = fyStartYear + Math.floor((fyStartMonth - 1 + i) / 12);
    const m = ((fyStartMonth - 1 + i) % 12) + 1;
    const key = `${y}-${pad(m)}`;
    // 進行中の今月は実績が途中のため「見込み」扱い（FY合計の過小評価を防ぐ）
    const isActual = key < curKey;
    let income: number, expense: number;
    if (isActual) {
      const a = actualMap.get(key);
      income = a?.income ?? 0;
      expense = (a?.fixed ?? 0) + (a?.variable ?? 0);
    } else {
      const t = targetMap.get(key);
      income = t?.income ?? avgIncome;
      expense = t?.expense ?? fixedPlan(key) + avgVariable;
    }
    const surplus = income - expense;
    if (!isActual) assets += surplus; // 実績月は現在の純資産に織り込み済み
    months.push({ key, income, expense, surplus, isActual, assets });
  }
  // 実績月の assets 表示は「現在の純資産」で固定（過去の再計算はしない）
  for (const r of months) if (r.isActual) r.assets = netAssets;

  // FYごとにまとめ
  const fys = Array.from({ length: 5 }, (_, f) => {
    const rows = months.slice(f * 12, f * 12 + 12);
    const label = `FY${fyStartYear + f}`;
    const income = rows.reduce((s, r) => s + r.income, 0);
    const expense = rows.reduce((s, r) => s + r.expense, 0);
    return { label, rows, income, expense, surplus: income - expense, endAssets: rows[11].assets };
  });

  // 純資産予測のSVGライン
  const W = 720;
  const H = 220;
  const padX = 40;
  const padY = 24;
  const maxA = Math.max(1, ...months.map((r) => r.assets));
  const minA = Math.min(0, ...months.map((r) => r.assets));
  const range = maxA - minA || 1;
  const px = (i: number) => padX + (i * (W - padX * 2)) / 59;
  const py = (v: number) => H - padY - ((v - minA) / range) * (H - padY * 2);
  const line = months.map((r, i) => `${px(i)},${py(r.assets)}`).join(" ");

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">🔮 5か年PL（フォーキャスト）</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ダッシュボード</Link>
        </header>

        {/* FYサマリカード */}
        <section className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {fys.map((fy) => (
            <div key={fy.label} className="bg-white rounded-2xl shadow-sm p-3">
              <div className="text-[10px] font-semibold tracking-wider text-slate-500">{fy.label}</div>
              <div
                className="text-sm font-extrabold tabular-nums"
                style={{ color: fy.surplus >= 0 ? C_SURPLUS_POS : C_SURPLUS_NEG }}
              >
                {fy.surplus >= 0 ? "+" : "−"}
                {man(Math.abs(fy.surplus))}
              </div>
              <div className="text-[10px] text-slate-400 tabular-nums">期末純資産 {man(fy.endAssets)}</div>
            </div>
          ))}
        </section>

        {/* 純資産の5か年予測 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">純資産の予測（60ヶ月）</h2>
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 560 }}>
              {/* 0ライン */}
              {minA < 0 && (
                <line x1={padX} y1={py(0)} x2={W - padX} y2={py(0)} stroke="#ddebe1" strokeDasharray="4 3" />
              )}
              {/* FY境界 */}
              {[12, 24, 36, 48].map((i) => (
                <line key={i} x1={px(i)} y1={padY} x2={px(i)} y2={H - padY} stroke="#eef5f0" />
              ))}
              <polyline points={line} fill="none" stroke={C_ASSET} strokeWidth={2.5} strokeLinejoin="round" />
              {/* 現在位置 */}
              {(() => {
                const idx = months.findIndex((r) => r.key === curKey);
                if (idx < 0) return null;
                return <circle cx={px(idx)} cy={py(months[idx].assets)} r={4} fill={C_ASSET} />;
              })()}
              {fys.map((fy, f) => (
                <text key={fy.label} x={px(f * 12 + 6)} y={H - 6} textAnchor="middle" fontSize="9" fill="#93a89b">
                  {fy.label}
                </text>
              ))}
              <text x={W - padX} y={py(months[59].assets) - 8} textAnchor="end" fontSize="10" fill={C_ASSET} fontWeight="bold">
                {man(months[59].assets)}
              </text>
            </svg>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            現在の純資産（{yen(netAssets)}）を起点に、未来月の黒字見込みを累積。●が現在。
          </p>
        </section>

        {/* FY別の月次テーブル */}
        {fys.map((fy, f) => (
          <details key={fy.label} className="bg-white rounded-2xl shadow-sm p-5" open={f === 0}>
            <summary className="text-sm font-semibold text-slate-600 cursor-pointer select-none">
              {fy.label}（収入 {man(fy.income)} ／ 支出 {man(fy.expense)} ／ 黒字{" "}
              <span style={{ color: fy.surplus >= 0 ? C_SURPLUS_POS : C_SURPLUS_NEG }}>
                {fy.surplus >= 0 ? "+" : "−"}{man(Math.abs(fy.surplus))}
              </span>
              ）
            </summary>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs tabular-nums" style={{ minWidth: 480 }}>
                <thead>
                  <tr className="text-slate-400 text-left">
                    <th className="py-1 font-medium">月</th>
                    <th className="py-1 font-medium text-right">収入</th>
                    <th className="py-1 font-medium text-right">支出</th>
                    <th className="py-1 font-medium text-right">黒字</th>
                    <th className="py-1 font-medium text-right">区分</th>
                  </tr>
                </thead>
                <tbody>
                  {fy.rows.map((r) => (
                    <tr key={r.key} className={"border-t border-slate-50 " + (r.key === curKey ? "bg-emerald-50/50" : "")}>
                      <td className="py-1">{r.key}</td>
                      <td className="py-1 text-right">{yen(r.income)}</td>
                      <td className="py-1 text-right">{yen(r.expense)}</td>
                      <td className="py-1 text-right font-semibold" style={{ color: r.surplus >= 0 ? C_SURPLUS_POS : C_SURPLUS_NEG }}>
                        {r.surplus >= 0 ? "+" : "−"}{Math.abs(r.surplus).toLocaleString("ja-JP")}
                      </td>
                      <td className="py-1 text-right text-[10px] text-slate-400">
                        {r.isActual ? "実績" : r.key === curKey ? "今月(見込)" : targetMap.has(r.key) ? "目標" : "見込み"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}

        <p className="text-center text-xs text-slate-400">
          未来月＝「目標（予実で設定）」を優先し、無い月は固定費マスタ＋直近6ヶ月平均（収入・変動費）で自動見込み（ADR-044）。
          精度を上げたい月は <Link href="/budget" className="text-sky-600 hover:underline">予実</Link> で目標を入れてください。
        </p>
      </div>
    </main>
  );
}
