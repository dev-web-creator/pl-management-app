import Link from "next/link";
import { getMonthTransactions } from "@/lib/queries";
import DeleteTxButton from "@/components/DeleteTxButton";

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

const PL_LABEL: Record<string, string> = {
  income: "収入",
  fixed_cost: "固定費",
  variable_cost: "変動費",
  deduction: "控除",
  excluded: "PL対象外",
};
const PL_COLOR: Record<string, string> = {
  income: "text-sky-600",
  fixed_cost: "text-indigo-500",
  variable_cost: "text-amber-600",
  deduction: "text-slate-500",
  excluded: "text-slate-400",
};

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const sp = await searchParams;
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const period = /^\d{4}-\d{2}-01$/.test(sp.m ?? "") ? (sp.m as string) : thisMonth;
  const rows = await getMonthTransactions(period);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link
              href={`/transactions?m=${addMonths(period, -1)}`}
              className="text-slate-400 hover:text-slate-900 text-lg leading-none px-1"
              aria-label="前の月"
            >
              ‹
            </Link>
            <h1 className="text-xl font-bold tabular-nums">取引一覧 ・ {monthLabel(period)}</h1>
            <Link
              href={`/transactions?m=${addMonths(period, 1)}`}
              className="text-slate-400 hover:text-slate-900 text-lg leading-none px-1"
              aria-label="次の月"
            >
              ›
            </Link>
          </div>
          <Link href={`/?m=${period}`} className="text-xs text-sky-600 hover:underline">
            ← ダッシュボード
          </Link>
        </header>

        <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 p-5">この月の取引はまだありません。</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">日付</th>
                  <th className="text-left px-3 py-2">カテゴリ</th>
                  <th className="text-left px-3 py-2 hidden sm:table-cell">決済</th>
                  <th className="text-right px-3 py-2">金額</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 tabular-nums text-slate-500 whitespace-nowrap">
                      {t.date.slice(5)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={"text-[10px] mr-1 " + (PL_COLOR[t.pl_type] ?? "")}>
                        {PL_LABEL[t.pl_type] ?? t.pl_type}
                      </span>
                      {t.category}
                      {t.memo && <span className="text-xs text-slate-400 ml-1">/ {t.memo}</span>}
                    </td>
                    <td className="px-3 py-2 hidden sm:table-cell text-slate-500">
                      {t.wallets ?? "—"}
                    </td>
                    <td
                      className={
                        "px-3 py-2 text-right tabular-nums font-semibold " +
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
        <p className="text-center text-xs text-slate-400">
          {rows.length} 件 ・ 削除すると残高・PL・集計に即反映されます。
        </p>
      </div>
    </main>
  );
}
