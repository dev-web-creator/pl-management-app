import Link from "next/link";
import { getMonthTransfers, getWalletOptions } from "@/lib/queries";
import AddTransferForm from "@/components/AddTransferForm";
import DeleteTransferButton from "@/components/DeleteTransferButton";

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

const KIND_LABEL: Record<string, string> = {
  transfer: "振替",
  charge: "チャージ",
  card_settlement: "カード支払い",
  cash_withdrawal: "現金引出",
};

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const sp = await searchParams;
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const period = /^\d{4}-\d{2}-01$/.test(sp.m ?? "") ? (sp.m as string) : thisMonth;
  const todayStr =
    period === thisMonth ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` : period;

  const [rows, wallets] = await Promise.all([getMonthTransfers(period), getWalletOptions()]);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href={`/transfers?m=${addMonths(period, -1)}`} className="text-slate-400 hover:text-slate-900 text-lg px-1" aria-label="前の月">
              ‹
            </Link>
            <h1 className="text-xl font-bold tabular-nums">資金移動 ・ {monthLabel(period)}</h1>
            <Link href={`/transfers?m=${addMonths(period, 1)}`} className="text-slate-400 hover:text-slate-900 text-lg px-1" aria-label="次の月">
              ›
            </Link>
          </div>
          <Link href={`/?m=${period}`} className="text-xs text-sky-600 hover:underline">
            ← ダッシュボード
          </Link>
        </header>

        <AddTransferForm wallets={wallets} today={todayStr} />

        <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 p-5">この月の資金移動はまだありません。</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">日付</th>
                  <th className="text-left px-3 py-2">種類</th>
                  <th className="text-left px-3 py-2">移動</th>
                  <th className="text-right px-3 py-2">金額</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 tabular-nums text-slate-500 whitespace-nowrap">{t.date.slice(5)}</td>
                    <td className="px-3 py-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        {KIND_LABEL[t.kind] ?? t.kind}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {t.from_name} <span className="text-slate-400">→</span> {t.to_name}
                      {t.memo && <span className="text-xs text-slate-400 ml-1">/ {t.memo}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      {yen(t.amount)}
                      {t.fee > 0 && <span className="text-[10px] text-slate-400 ml-1">(手数料 {yen(t.fee)})</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <DeleteTransferButton id={t.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <p className="text-center text-xs text-slate-400">
          {rows.length} 件 ・ 資金移動はPLには計上されず、残高にのみ反映されます。
        </p>
      </div>
    </main>
  );
}
