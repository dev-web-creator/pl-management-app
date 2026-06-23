import Link from "next/link";
import { getBudgetVsActual } from "@/lib/queries";
import BudgetForm from "@/components/BudgetForm";
import ConfirmMonthButton from "@/components/ConfirmMonthButton";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const pad = (n: number) => String(n).padStart(2, "0");
function addMonths(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}
function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${y}年${m}月`;
}
const pct = (actual: number, target: number) => (target > 0 ? Math.round((actual / target) * 100) : null);

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const sp = await searchParams;
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const period = /^\d{4}-\d{2}-01$/.test(sp.m ?? "") ? (sp.m as string) : thisMonth;

  const b = await getBudgetVsActual(period);
  const netTarget = b.target_income - b.target_expense;
  const netActual = b.actual_income - b.actual_expense;

  const rows = [
    { key: "収入", target: b.target_income, actual: b.actual_income, kind: "income" as const },
    { key: "支出", target: b.target_expense, actual: b.actual_expense, kind: "expense" as const },
    { key: "収支（黒字）", target: netTarget, actual: netActual, kind: "net" as const },
  ];

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className={"max-w-3xl mx-auto space-y-5 " + (b.closed ? "ring-2 ring-slate-800 rounded-2xl p-1" : "")}>
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href={`/budget?m=${addMonths(period, -1)}`} className="text-slate-400 hover:text-slate-900 text-lg px-1" aria-label="前の月">‹</Link>
            <h1 className="text-xl font-bold tabular-nums">予実 ・ {monthLabel(period)}</h1>
            <Link href={`/budget?m=${addMonths(period, 1)}`} className="text-slate-400 hover:text-slate-900 text-lg px-1" aria-label="次の月">›</Link>
            {b.closed && <span className="text-[10px] bg-slate-800 text-white px-2 py-0.5 rounded">確定済み</span>}
          </div>
          <Link href={`/?m=${period}`} className="text-xs text-sky-600 hover:underline">← ダッシュボード</Link>
        </header>

        {/* 予実テーブル */}
        <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2">区分</th>
                <th className="text-right px-3 py-2">目標</th>
                <th className="text-right px-3 py-2">実績</th>
                <th className="text-right px-3 py-2">達成率</th>
                <th className="text-right px-3 py-2 hidden sm:table-cell">差異</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const p = pct(r.actual, r.target);
                const diff = r.actual - r.target;
                // 支出は「予算以内＝良い」、収入/収支は「目標以上＝良い」
                const over = r.kind === "expense" ? p != null && p > 100 : false;
                return (
                  <tr key={r.key}>
                    <td className="px-3 py-2 font-medium">{r.key}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{yen(r.target)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{yen(r.actual)}</td>
                    <td className={"px-3 py-2 text-right tabular-nums font-semibold " + (over ? "text-red-500" : "text-slate-700")}>
                      {p != null ? `${p}%` : "—"}
                    </td>
                    <td className={"px-3 py-2 text-right tabular-nums hidden sm:table-cell " + (diff < 0 ? "text-red-500" : "text-emerald-600")}>
                      {diff >= 0 ? "+" : "−"}{yen(Math.abs(diff))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <BudgetForm
          period={period}
          initialIncome={b.target_income}
          initialExpense={b.target_expense}
          initialTotalAssets={b.target_total_assets}
        />

        <div className="flex items-center justify-between bg-white rounded-2xl shadow-sm p-4">
          <div className="text-xs text-slate-500">
            月の集計が固まったら「確定」。済んだ月を視覚的に区別できます（黒塗り）。
          </div>
          <ConfirmMonthButton period={period} closed={b.closed} />
        </div>

        <p className="text-center text-xs text-slate-400">
          実績は当月の取引から自動集計（収入＝収入カテゴリ／支出＝固定費＋変動費）。目標は総額（ADR-018）。
        </p>
      </div>
    </main>
  );
}
