import Link from "next/link";
import { getPayslips } from "@/lib/queries";
import DeletePayslipButton from "@/components/DeletePayslipButton";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

export default async function PayslipsPage() {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const rows = await getPayslips();

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">給与明細</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">
            ← ダッシュボード
          </Link>
        </header>

        <Link
          href={`/payslips/${thisMonth}/edit`}
          className="block w-full text-center bg-slate-900 text-white rounded-2xl py-3 font-semibold shadow-sm hover:bg-slate-700"
        >
          ＋ 今月（{thisMonth}）の給与明細を入力 / 編集
        </Link>

        <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 p-5">まだ給与明細がありません。上のボタンから入力してください。</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">年月</th>
                  <th className="text-right px-3 py-2">総支給</th>
                  <th className="text-right px-3 py-2 hidden sm:table-cell">控除</th>
                  <th className="text-right px-3 py-2">手取り</th>
                  <th className="text-right px-3 py-2 hidden md:table-cell">時給換算</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                      {p.period}
                      {!p.is_confirmed && <span className="text-[10px] text-slate-400 ml-1">予定</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{yen(p.gross)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 hidden sm:table-cell">{yen(p.deduction)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-600">{yen(p.net)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400 hidden md:table-cell">
                      {p.hourly != null ? `${yen(p.hourly)}/h` : "—"}
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      <Link href={`/payslips/${p.period}/edit`} className="text-xs text-sky-600 hover:underline mr-3">
                        編集
                      </Link>
                      <DeletePayslipButton id={p.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <p className="text-center text-xs text-slate-400">
          税金・社保は控除として管理（支出には計上しません）。手取りはPLのトップライン＝可処分所得に対応します。
        </p>
      </div>
    </main>
  );
}
