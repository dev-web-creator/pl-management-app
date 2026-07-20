import {
  getPLSummary,
  getWalletBalances,
  getAssets,
  getVariableGroups,
  getInputCategories,
  getWalletOptions,
  getFixedCostPlanVsActual,
  hasNoTransactions,
} from "@/lib/queries";
import AddTransactionForm from "@/components/AddTransactionForm";
import RecordFixedCostButton from "@/components/RecordFixedCostButton";
import Link from "next/link";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic"; // 毎回DBから最新を取得（キャッシュしない）

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const pad = (n: number) => String(n).padStart(2, "0");

// 'YYYY-MM-01' を delta ヶ月ずらす
function addMonths(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}
// 'YYYY-MM-01' → '2026年6月'
function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${y}年${m}月`;
}

const TYPE_LABEL: Record<string, string> = {
  bank: "銀行",
  prepaid: "プリペイド",
  points: "ポイント",
  cash: "現金",
  crypto: "暗号資産",
  credit_card: "クレカ(未払い)",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  await requireAuth();
  const sp = await searchParams;

  // 対象月：?m=YYYY-MM-01 があればそれ、無ければサーバーの「今月」
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const period = /^\d{4}-\d{2}-01$/.test(sp.m ?? "") ? (sp.m as string) : thisMonth;
  const prevMonth = addMonths(period, -1);
  const nextMonth = addMonths(period, 1);

  // 入力フォームの既定日：今月を見ているなら今日、それ以外はその月の1日
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const formDefaultDate = period === thisMonth ? todayStr : period;

  const [pl, wallets, assets, varGroups, inputCats, walletOpts, fixedItems, prevPl, prevFixedItems, isNew] =
    await Promise.all([
      getPLSummary(period),
      getWalletBalances(),
      getAssets(),
      getVariableGroups(period),
      getInputCategories(),
      getWalletOptions(),
      getFixedCostPlanVsActual(period),
      getPLSummary(prevMonth),
      getFixedCostPlanVsActual(prevMonth),
      hasNoTransactions(),
    ]);

  // 固定費は予実突合（ADR-030）：各項目 実額があれば実額、無ければ予定額。
  const fixedEffective = fixedItems.reduce((s, f) => s + f.effective, 0);
  const fixedPlan = fixedItems.reduce((s, f) => s + f.plan, 0);
  const fixedActualCount = fixedItems.filter((f) => f.is_actual).length;
  // 月次黒字＝可処分所得 −（固定費[実績優先] ＋ 変動費）
  const surplus = pl.disposable - fixedEffective - pl.variable;
  // 前月比（同じ定義で前月の黒字を算出）
  const prevSurplus =
    prevPl.disposable - prevFixedItems.reduce((s, f) => s + f.effective, 0) - prevPl.variable;
  const surplusDelta = surplus - prevSurplus;
  const savingsRate = pl.disposable > 0 ? Math.round((surplus / pl.disposable) * 100) : null;

  return (
    <main className="min-h-screen px-4 py-7">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-end justify-between">
          <div>
            <p className="text-[11px] font-bold tracking-[0.22em] uppercase text-[var(--muted)]">
              Monthly P/L
            </p>
            <h1 className="text-2xl font-extrabold tracking-tight tabular-nums mt-0.5">
              {monthLabel(period)}
            </h1>
          </div>
          <div className="flex items-center gap-0.5 bg-white border border-[var(--line)] rounded-xl p-1">
            <Link
              href={`/?m=${prevMonth}`}
              className="w-8 h-8 grid place-items-center rounded-lg text-[var(--muted)] hover:bg-black/5"
              aria-label="前の月"
            >
              ‹
            </Link>
            <Link
              href={`/?m=${nextMonth}`}
              className="w-8 h-8 grid place-items-center rounded-lg text-[var(--muted)] hover:bg-black/5"
              aria-label="次の月"
            >
              ›
            </Link>
          </div>
        </header>

        {/* 新規ユーザー向けオンボーディング（取引ゼロのときだけ / ADR-051） */}
        {isNew && (
          <section className="bg-white rounded-2xl shadow-sm p-5 border border-emerald-100">
            <h2 className="text-base font-bold">🌱 ようこそ！まず3ステップだけ</h2>
            <p className="text-xs text-slate-500 mt-1 mb-3">
              あなた専用の初期データが用意されています。次の順で設定すると、毎日の入力がスムーズです。
            </p>
            <ol className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <span className="w-5 h-5 grid place-items-center rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold shrink-0">1</span>
                <Link href="/wallets" className="text-sky-600 hover:underline">🏦 口座・カードを登録</Link>
                <span className="text-slate-400 text-xs">（あなたの銀行・クレカ・電子マネー）</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-5 h-5 grid place-items-center rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold shrink-0">2</span>
                <Link href="/fixed-costs" className="text-sky-600 hover:underline">📌 固定費を登録</Link>
                <span className="text-slate-400 text-xs">（家賃・サブスクなど毎月の固定支出）</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-5 h-5 grid place-items-center rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold shrink-0">3</span>
                <span>下の「＋取引を入力」から支出を記録</span>
              </li>
            </ol>
            <Link href="/guide" className="inline-block mt-3 text-xs font-semibold text-emerald-700 hover:underline">
              📖 使い方ガイドを見る →
            </Link>
          </section>
        )}

        {/* 入力フォーム */}
        <AddTransactionForm
          categories={inputCats}
          wallets={walletOpts}
          today={formDefaultDate}
        />

        {/* 損益のヒーロー：月次黒字を主役に */}
        <section className="bg-white rounded-2xl shadow-sm p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-[var(--muted)]">
                月次黒字 · Bottom line
              </p>
              <div
                className={
                  "mt-1 text-[2.75rem] leading-none font-extrabold tabular-nums " +
                  (surplus >= 0 ? "text-[var(--positive)]" : "text-[var(--negative)]")
                }
              >
                {surplus < 0 ? "−" : ""}
                {yen(Math.abs(surplus))}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
                {savingsRate != null && (
                  <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 rounded-full px-2.5 py-1 font-medium tabular-nums">
                    貯蓄率 {savingsRate}%
                  </span>
                )}
                <span
                  className={
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium tabular-nums " +
                    (surplusDelta >= 0 ? "bg-emerald-50 text-[var(--positive)]" : "bg-red-50 text-[var(--negative)]")
                  }
                >
                  前月比 {surplusDelta >= 0 ? "+" : "−"}{yen(Math.abs(surplusDelta))}
                </span>
              </div>
            </div>
            <span
              className={
                "shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full " +
                (surplus >= 0 ? "bg-emerald-50 text-[var(--positive)]" : "bg-red-50 text-[var(--negative)]")
              }
            >
              {surplus >= 0 ? "黒字" : "赤字"}
            </span>
          </div>

          {/* 損益の内訳（帳簿） */}
          <div className="mt-5 border-t border-[var(--line)] pt-4 space-y-2.5">
            <LedgerRow label="可処分所得" sub="手取り・トップライン" value={pl.disposable} color="#3f9d76" />
            <LedgerRow
              label="固定費"
              sub="実績優先"
              value={-fixedEffective}
              color="#4aafd5"
              pct={pl.disposable > 0 ? Math.round((fixedEffective / pl.disposable) * 100) : null}
            />
            <LedgerRow
              label="変動費"
              value={-pl.variable}
              color="#e2724f"
              pct={pl.disposable > 0 ? Math.round((pl.variable / pl.disposable) * 100) : null}
            />
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            （PL対象外）経費精算など {yen(pl.excluded)} は残高に反映し、損益には含めません。
          </p>
        </section>

        {/* 資産サマリ（タップで資産ダッシュボードへ） */}
        <Link href="/assets" className="block">
          <section className="grid grid-cols-3 gap-3">
            <div className="summary-card income">
              <span className="summary-label">総資産</span>
              <span className="summary-value">{yen(assets.total_assets)}</span>
            </div>
            <div className="summary-card expense">
              <span className="summary-label">カード未払い</span>
              <span className="summary-value">−{yen(assets.card_unpaid)}</span>
            </div>
            <div className="summary-card net">
              <span className="summary-label">純資産 ›</span>
              <span className="summary-value">{yen(assets.net_assets)}</span>
            </div>
          </section>
        </Link>

        {/* 固定費（予実：マスタの予定 / 実績） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="text-sm font-semibold text-slate-500">
              固定費（予実：マスタ予定 / 実績）
            </h2>
            <span className="text-[10px] text-slate-400">
              実績 {fixedActualCount} / {fixedItems.length} 件
              <Link href="/fixed-costs" className="text-sky-600 hover:underline ml-2">
                管理
              </Link>
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mb-3">
            予定額はマスタ(recurring_rules)から自動表示。実額の取引が入るとその額を優先（解約は終了年月で自動的に消えます）。
          </p>
          {fixedItems.length === 0 ? (
            <p className="text-sm text-slate-400">この月にアクティブな固定費はありません。</p>
          ) : (
            <div className="space-y-1.5">
              {fixedItems.map((f) => (
                <div key={f.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">
                    {f.name}
                    {f.wallet_name && (
                      <span className="text-[10px] text-slate-400 ml-2">{f.wallet_name}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className={f.is_actual ? "text-emerald-600 font-semibold" : "text-slate-400"}>
                      {yen(f.is_actual ? (f.actual as number) : f.plan)}
                    </span>
                    <span
                      className={
                        "text-[10px] px-1.5 py-0.5 rounded shrink-0 " +
                        (f.is_actual
                          ? "bg-emerald-50 text-emerald-600"
                          : "bg-slate-100 text-slate-400")
                      }
                    >
                      {f.is_actual ? "実績" : "予定"}
                    </span>
                    {!f.is_actual && (
                      <RecordFixedCostButton ruleId={f.id} period={period} />
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          <hr className="my-3" />
          <div className="flex justify-between text-sm font-semibold">
            <span>固定費 合計（実績優先＝PL計上額）</span>
            <span className="tabular-nums text-indigo-600">{yen(fixedEffective)}</span>
          </div>
          <div className="flex justify-between text-[11px] text-slate-400 mt-0.5">
            <span>うち予定ベース合計</span>
            <span className="tabular-nums">{yen(fixedPlan)}</span>
          </div>
        </section>

        {/* 変動費グループ＋カテゴリ別比率グラフ */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">
            変動費 内訳（グループ／自動集計）
          </h2>
          {(() => {
            const palette = ["#4cb586", "#4aafd5", "#f5b642", "#e2724f", "#8fc7a9", "#a4b8ad"];
            const varTotal = varGroups.reduce((s, g) => s + g.total, 0);
            return (
              <>
                {varTotal > 0 && (
                  <div className="flex h-5 rounded-full overflow-hidden mb-3">
                    {varGroups.map((g, i) =>
                      g.total > 0 ? (
                        <div
                          key={g.id}
                          style={{ width: `${(g.total / varTotal) * 100}%`, background: palette[i % palette.length] }}
                          title={`${g.name} ${yen(g.total)}`}
                        />
                      ) : null
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  {varGroups.map((g, i) => (
                    <div key={g.id} className="flex justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-sm" style={{ background: palette[i % palette.length] }} />
                        {g.name}
                        {varTotal > 0 && (
                          <span className="text-[10px] text-slate-400">{Math.round((g.total / varTotal) * 100)}%</span>
                        )}
                      </span>
                      <span className="tabular-nums font-semibold text-amber-600">{yen(g.total)}</span>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </section>

        {/* ウォレット残高 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">
            ウォレット残高（取引・振替から算出）
          </h2>
          <div className="space-y-2">
            {wallets.map((w) => (
              <div key={w.name} className="flex justify-between text-sm">
                <span>
                  {w.name}
                  <span className="text-[10px] text-slate-400 ml-2">
                    {TYPE_LABEL[w.type] ?? w.type}
                  </span>
                </span>
                <span
                  className={
                    "tabular-nums font-semibold " +
                    (w.type === "credit_card" ? "text-red-500" : "")
                  }
                >
                  {w.type === "credit_card" ? "−" : ""}
                  {yen(Math.abs(w.balance))}
                </span>
              </div>
            ))}
          </div>
        </section>

        <p className="text-center text-xs text-slate-400">
          数値は全て transactions / transaction_legs / transfers から集計（残高カラムは持たない）。
          固定費は recurring_rules（予定）と取引（実績）の突合。
        </p>
      </div>
    </main>
  );
}

function LedgerRow({
  label,
  sub,
  value,
  color,
  pct,
}: {
  label: string;
  sub?: string;
  value: number;
  color: string;
  pct?: number | null; // 手取り（可処分所得）に対する比率（現運用シートの「収入比」）
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2.5">
        <span className="w-1.5 h-5 rounded-full" style={{ background: color }} />
        <span className="text-sm">
          <span className="font-medium">{label}</span>
          {sub && <span className="text-[11px] text-[var(--muted)] ml-1.5">{sub}</span>}
        </span>
      </span>
      <span className="text-sm font-semibold tabular-nums">
        {pct != null && (
          <span className="text-[10px] font-normal text-[var(--muted)] mr-2">手取り比 {pct}%</span>
        )}
        {value < 0 ? "−" : ""}
        {yen(Math.abs(value))}
      </span>
    </div>
  );
}
