import Link from "next/link";
import {
  getDailyTotals,
  getDayTransactions,
  getInputCategories,
  getWalletOptions,
} from "@/lib/queries";
import AddTransactionForm from "@/components/AddTransactionForm";
import DeleteTxButton from "@/components/DeleteTxButton";
import { requireAuth } from "@/lib/auth";

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
// 金額の短縮表示（セル内が溢れないように 1.2万 のように丸める）
function shortYen(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + "万";
  return n.toLocaleString("ja-JP");
}

const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const MOOD_EMOJI: Record<number, string> = { 1: "😩", 2: "😕", 3: "😐", 4: "🙂", 5: "😆" };

// カレンダー入力（②/ADR-034）：1ヶ月をカレンダー表示し、日毎の支出を確認、
// 日付タップでその日の入力フォームと取引一覧を開く（スプレッドシートの日次タブの再現）。
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; d?: string }>;
}) {
  await requireAuth();
  const sp = await searchParams;

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const period = /^\d{4}-\d{2}-01$/.test(sp.m ?? "") ? (sp.m as string) : thisMonth;
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(sp.d ?? "") ? (sp.d as string) : null;

  const [y, m] = period.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=日

  const [daily, cats, wallets, dayRows] = await Promise.all([
    getDailyTotals(period),
    getInputCategories(),
    getWalletOptions(),
    selected ? getDayTransactions(selected) : Promise.resolve([]),
  ]);
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const monthExpense = daily.reduce((s, d) => s + d.expense, 0);
  const dayExpense = dayRows.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link
              href={`/calendar?m=${addMonths(period, -1)}`}
              className="text-slate-400 hover:text-slate-900 text-lg leading-none px-1"
              aria-label="前の月"
            >
              ‹
            </Link>
            <h1 className="text-xl font-bold tabular-nums">
              <span className="deco mr-1" aria-hidden="true">📅</span>
              {monthLabel(period)}
            </h1>
            <Link
              href={`/calendar?m=${addMonths(period, 1)}`}
              className="text-slate-400 hover:text-slate-900 text-lg leading-none px-1"
              aria-label="次の月"
            >
              ›
            </Link>
          </div>
          <span className="text-xs text-slate-500 tabular-nums">
            月の支出 <span className="font-bold text-red-500">{yen(monthExpense)}</span>
          </span>
        </header>

        {/* カレンダー */}
        <section className="bg-white rounded-2xl shadow-sm p-4">
          <div className="cal-grid mb-1">
            {DOW.map((d, i) => (
              <div key={d} className={"cal-dow" + (i === 0 ? " sun" : i === 6 ? " sat" : "")}>
                {d}
              </div>
            ))}
          </div>
          <div className="cal-grid">
            {Array.from({ length: firstDow }).map((_, i) => (
              <span key={`e${i}`} className="cal-day empty" />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const date = period.slice(0, 8) + pad(day); // 'YYYY-MM-' + 'DD'
              const dow = (firstDow + i) % 7;
              const t = byDate.get(date);
              const cls = [
                "cal-day",
                dow === 0 ? "sun" : dow === 6 ? "sat" : "",
                date === todayStr ? "today" : "",
                date === selected ? "selected" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <Link key={date} href={`/calendar?m=${period}&d=${date}`} className={cls}>
                  <span className="d">{day}</span>
                  {t && t.expense > 0 && <span className="amt">−{shortYen(t.expense)}</span>}
                </Link>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 mt-3">
            日付をタップするとその日の入力と明細が開きます。セルの赤字はその日の支出（固定費＋変動費）。
          </p>
        </section>

        {/* 選択日の入力＋明細 */}
        {selected ? (
          <>
            <h2 className="text-sm font-bold text-slate-600 tabular-nums">
              {Number(selected.slice(5, 7))}月{Number(selected.slice(8, 10))}日（
              {DOW[new Date(selected + "T00:00:00").getDay()]}）
              {dayExpense > 0 && (
                <span className="ml-2 text-red-500">支出 {yen(dayExpense)}</span>
              )}
            </h2>
            <AddTransactionForm
              key={selected}
              categories={cats}
              wallets={wallets}
              today={selected}
              defaultOpen
            />
            <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
              {dayRows.length === 0 ? (
                <p className="text-sm text-slate-400 p-5">この日の取引はまだありません。</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y">
                    {dayRows.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2">
                          {t.category}
                          {t.memo && <span className="text-xs text-slate-400 ml-1">/ {t.memo}</span>}
                          {t.mood && <span className="ml-1">{MOOD_EMOJI[t.mood]}</span>}
                          {t.wallets && (
                            <span className="text-[10px] text-slate-400 ml-1 hidden sm:inline">
                              （{t.wallets}）
                            </span>
                          )}
                        </td>
                        <td
                          className={
                            "px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap " +
                            (t.type === "income" ? "text-sky-600" : "")
                          }
                        >
                          {t.type === "income" ? "+" : "−"}
                          {yen(t.amount)}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <Link
                            href={`/transactions/${t.id}/edit`}
                            className="text-xs text-sky-600 hover:underline mr-3"
                          >
                            編集
                          </Link>
                          <DeleteTxButton id={t.id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        ) : (
          <p className="text-center text-xs text-slate-400">
            カレンダーの日付をタップすると、その日の入力フォームが開きます。
          </p>
        )}
      </div>
    </main>
  );
}
