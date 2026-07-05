import Link from "next/link";
import { getWeeklyProgress } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

// 週次進捗（ADR-036）：現運用「(週次)進捗」タブの再現。
// 直近12週の変動費を、週×ルートグループでロールアップして表示する。
export default async function WeeklyPage() {
  await requireAuth();
  const { groups, rows } = await getWeeklyProgress(12);

  // 今週（月曜始まり）の開始日
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const p = (n: number) => String(n).padStart(2, "0");
  const thisWeek = `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">
            <span className="deco mr-1" aria-hidden="true">📆</span>
            週次進捗（変動費）
          </h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">
            ← ダッシュボード
          </Link>
        </header>

        <p className="text-[11px] text-slate-500 bg-white rounded-lg p-3">
          月曜始まりの週ごとに変動費を自動集計（直近12週・グループはカテゴリツリーで自動ロールアップ）。
          「今週使いすぎてないか」を月の締めを待たずに確認する用。
        </p>

        <section className="bg-white rounded-2xl shadow-sm overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 p-5">直近12週の変動費データがまだありません。</p>
          ) : (
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">週</th>
                  <th className="text-right px-3 py-2">合計</th>
                  {groups.map((g) => (
                    <th key={g} className="text-right px-3 py-2">
                      {g}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((w) => (
                  <tr
                    key={w.week_start}
                    className={"hover:bg-slate-50 " + (w.week_start === thisWeek ? "bg-emerald-50/40" : "")}
                  >
                    <td className="px-3 py-2 tabular-nums text-slate-500">
                      {md(w.week_start)}〜{md(w.week_end)}
                      {w.week_start === thisWeek && (
                        <span className="text-[10px] text-emerald-600 ml-1.5 font-bold">今週</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold">{yen(w.total)}</td>
                    {groups.map((g) => (
                      <td key={g} className="px-3 py-2 text-right tabular-nums text-slate-600">
                        {w.groups[g] ? yen(w.groups[g]) : <span className="text-slate-300">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}
