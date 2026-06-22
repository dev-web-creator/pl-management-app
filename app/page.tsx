import {
  getPLSummary,
  getWalletBalances,
  getAssets,
  getVariableGroups,
  getInputCategories,
  getWalletOptions,
  getFixedCostPlanVsActual,
} from "@/lib/queries";
import AddTransactionForm from "@/components/AddTransactionForm";
import RecordFixedCostButton from "@/components/RecordFixedCostButton";
import Link from "next/link";

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
  credit_card: "クレカ(未払い)",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
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

  const [pl, wallets, assets, varGroups, inputCats, walletOpts, fixedItems] =
    await Promise.all([
      getPLSummary(period),
      getWalletBalances(),
      getAssets(),
      getVariableGroups(period),
      getInputCategories(),
      getWalletOptions(),
      getFixedCostPlanVsActual(period),
    ]);

  // 固定費は予実突合（ADR-030）：各項目 実額があれば実額、無ければ予定額。
  const fixedEffective = fixedItems.reduce((s, f) => s + f.effective, 0);
  const fixedPlan = fixedItems.reduce((s, f) => s + f.plan, 0);
  const fixedActualCount = fixedItems.filter((f) => f.is_actual).length;
  // 月次黒字＝可処分所得 −（固定費[実績優先] ＋ 変動費）
  const surplus = pl.disposable - fixedEffective - pl.variable;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link
              href={`/?m=${prevMonth}`}
              className="text-slate-400 hover:text-slate-900 text-lg leading-none px-1"
              aria-label="前の月"
            >
              ‹
            </Link>
            <h1 className="text-xl font-bold tabular-nums">
              My PL ・ {monthLabel(period)}
            </h1>
            <Link
              href={`/?m=${nextMonth}`}
              className="text-slate-400 hover:text-slate-900 text-lg leading-none px-1"
              aria-label="次の月"
            >
              ›
            </Link>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <Link href={`/transactions?m=${period}`} className="text-sky-600 hover:underline">
              取引一覧
            </Link>
            <Link href={`/transfers?m=${period}`} className="text-sky-600 hover:underline">
              振替
            </Link>
            <Link href="/payslips" className="text-sky-600 hover:underline">
              給与
            </Link>
            <Link href={`/budget?m=${period}`} className="text-sky-600 hover:underline">
              予実
            </Link>
            <Link href="/inspect" className="text-sky-600 hover:underline">
              🔍 DB
            </Link>
          </div>
        </header>

        {/* 入力フォーム */}
        <AddTransactionForm
          categories={inputCats}
          wallets={walletOpts}
          today={formDefaultDate}
        />

        {/* PLサマリ */}
        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-2">
          <h2 className="text-sm font-semibold text-slate-500 mb-2">
            {monthLabel(period)}のPL（損益計算書）
          </h2>
          <Row label="可処分所得（手取り・トップライン）" value={pl.disposable} bold />
          <div className="text-xs text-slate-400 text-right">
            （PL対象外）経費精算など {yen(pl.excluded)} は残高に反映・損益には含めず
          </div>
          <hr />
          <Row label="− 固定費（実績優先）" value={fixedEffective} className="text-indigo-500" />
          <Row label="− 変動費" value={pl.variable} className="text-amber-500" />
          <hr />
          <div className="flex items-center justify-between bg-emerald-50 -mx-2 px-3 py-2 rounded-xl">
            <span className="font-bold">月次黒字（貯蓄に回る額）</span>
            <span className="text-2xl font-extrabold text-emerald-600 tabular-nums">
              {yen(surplus)}
            </span>
          </div>
        </section>

        {/* 資産サマリ（タップで資産ダッシュボードへ） */}
        <Link href="/assets" className="block">
          <section className="grid grid-cols-3 gap-3">
            <Stat label="総資産" value={assets.total_assets} />
            <Stat label="カード未払い" value={assets.card_unpaid} negative />
            <Stat label="純資産 ›" value={assets.net_assets} accent />
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

        {/* 変動費グループ */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">
            変動費 内訳（グループ／自動集計）
          </h2>
          <div className="space-y-2">
            {varGroups.map((g) => (
              <div key={g.id} className="flex justify-between text-sm">
                <span>{g.name}</span>
                <span className="tabular-nums font-semibold text-amber-600">
                  {yen(g.total)}
                </span>
              </div>
            ))}
          </div>
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

function Row({
  label,
  value,
  bold,
  className = "",
}: {
  label: string;
  value: number;
  bold?: boolean;
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? "font-semibold" : className}>{label}</span>
      <span className={"tabular-nums " + (bold ? "text-lg font-bold" : className)}>
        {yen(value)}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  negative,
  accent,
}: {
  label: string;
  value: number;
  negative?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 text-center">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className={
          "text-lg font-bold tabular-nums " +
          (negative ? "text-red-500" : accent ? "text-emerald-600" : "")
        }
      >
        {negative ? "−" : ""}
        {yen(value)}
      </div>
    </div>
  );
}
