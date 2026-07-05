import Link from "next/link";
import {
  getRecurringRules,
  getFixedCostCategories,
  getWalletOptions,
} from "@/lib/queries";
import RecurringForm from "@/components/RecurringForm";
import DeleteRecurringButton from "@/components/DeleteRecurringButton";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

export default async function FixedCostsPage() {
  await requireAuth();
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const [rules, cats, wallets] = await Promise.all([
    getRecurringRules(),
    getFixedCostCategories(),
    getWalletOptions(),
  ]);

  // 月額と年額サブスク（ADR-035）を分けて表示
  const monthly = rules.filter((r) => r.billing_cycle !== "yearly");
  const yearly = rules.filter((r) => r.billing_cycle === "yearly");
  const monthlyActive = monthly.filter((r) => !r.end_month);
  const yearlyActive = yearly.filter((r) => !r.end_month);
  const monthlyTotal = monthlyActive.reduce((s, r) => s + r.amount, 0);
  const yearlyTotal = yearlyActive.reduce((s, r) => s + r.amount, 0);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">固定費マスタの管理</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">
            ← ダッシュボード
          </Link>
        </header>

        <p className="text-[11px] text-slate-500 bg-white rounded-lg p-3">
          ここで登録した「予定額」が、毎月のダッシュボードに自動表示されます（取引の実額が入ればそちらを優先）。
          解約は<b>「終了年月」をセット</b>するだけ（履歴は残り、その月から自動で計上対象外に）。
        </p>

        <RecurringForm categories={cats} wallets={wallets} defaultMonth={defaultMonth} />

        <section className="bg-white rounded-2xl shadow-sm p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-500">
              <span className="deco mr-1" aria-hidden="true">📌</span>月額固定費
            </h2>
            <span className="text-xs text-slate-500">
              継続中 {monthlyActive.length} 件 ・ 月合計（予定）
              <span className="font-bold text-indigo-600 ml-1 tabular-nums">{yen(monthlyTotal)}</span>
            </span>
          </div>

          {monthly.length === 0 ? (
            <p className="text-sm text-slate-400">まだ登録がありません。上の「＋ 固定費を追加」から登録してください。</p>
          ) : (
            <div className="divide-y">
              {monthly.map((r) => {
                const ended = !!r.end_month;
                return (
                  <div
                    key={r.id}
                    className={"flex items-center justify-between py-2.5 " + (ended ? "opacity-40" : "")}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {r.name}
                        {ended && <span className="text-[10px] text-red-400 ml-2">解約済</span>}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {r.category_name} ・ {r.wallet_name ?? "—"} ・ {r.start_month}〜
                        {r.end_month ?? "継続中"}
                        {r.billing_day ? ` ・ 毎月${r.billing_day}日` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 pl-3">
                      <span className="tabular-nums font-semibold">{yen(r.amount)}</span>
                      <Link
                        href={`/fixed-costs/${r.id}/edit`}
                        className="text-xs text-sky-600 hover:underline"
                      >
                        編集
                      </Link>
                      <DeleteRecurringButton id={r.id} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 年額サブスク（ADR-035）：月次PLには出さない管理台帳。 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="text-sm font-semibold text-slate-500">
              <span className="deco mr-1" aria-hidden="true">🗓️</span>年額サブスク
            </h2>
            <span className="text-xs text-slate-500">
              継続中 {yearlyActive.length} 件 ・ 年合計
              <span className="font-bold text-sky-600 ml-1 tabular-nums">{yen(yearlyTotal)}</span>
              {yearlyTotal > 0 && (
                <span className="text-slate-400 ml-1 tabular-nums">
                  （月割 {yen(Math.round(yearlyTotal / 12))}）
                </span>
              )}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mb-3">
            年間払いは支払った月の変動費（物品購入費など）として取引入力する運用のまま、ここは「年間いくら払っているか」の台帳。
            毎月の固定費（予定）には出ません。
          </p>
          {yearly.length === 0 ? (
            <p className="text-sm text-slate-400">
              まだ登録がありません。追加フォームで「年額サブスク」を選ぶとここに入ります。
            </p>
          ) : (
            <div className="divide-y">
              {yearly.map((r) => {
                const ended = !!r.end_month;
                return (
                  <div
                    key={r.id}
                    className={"flex items-center justify-between py-2.5 " + (ended ? "opacity-40" : "")}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {r.name}
                        {ended && <span className="text-[10px] text-red-400 ml-2">解約済</span>}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {r.category_name} ・ {r.wallet_name ?? "—"} ・ {r.start_month}〜
                        {r.end_month ?? "継続中"}
                        {r.payment_month ? ` ・ 毎年${r.payment_month}月払い` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 pl-3">
                      <span className="tabular-nums font-semibold">
                        {yen(r.amount)}
                        <span className="text-[10px] text-slate-400 font-normal">/年</span>
                      </span>
                      <Link
                        href={`/fixed-costs/${r.id}/edit`}
                        className="text-xs text-sky-600 hover:underline"
                      >
                        編集
                      </Link>
                      <DeleteRecurringButton id={r.id} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
