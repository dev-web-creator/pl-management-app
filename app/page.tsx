import {
  getPLSummary,
  getWalletBalances,
  getAssets,
  getVariableGroups,
  getInputCategories,
  getWalletOptions,
} from "@/lib/queries";
import AddTransactionForm from "@/components/AddTransactionForm";
import Link from "next/link";

export const dynamic = "force-dynamic"; // 毎回DBから最新を取得（キャッシュしない）

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

const TYPE_LABEL: Record<string, string> = {
  bank: "銀行",
  prepaid: "プリペイド",
  points: "ポイント",
  cash: "現金",
  credit_card: "クレカ(未払い)",
};

export default async function Home() {
  const [pl, wallets, assets, varGroups, inputCats, walletOpts] = await Promise.all([
    getPLSummary("2026-06-01"),
    getWalletBalances(),
    getAssets(),
    getVariableGroups(),
    getInputCategories(),
    getWalletOptions(),
  ]);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">My PL ・ 2026年6月</h1>
          <Link href="/inspect" className="text-xs text-sky-600 hover:underline">
            🔍 DBの中身を見る
          </Link>
        </header>

        {/* 入力フォーム */}
        <AddTransactionForm
          categories={inputCats}
          wallets={walletOpts}
          today="2026-06-06"
        />

        {/* PLサマリ */}
        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-2">
          <h2 className="text-sm font-semibold text-slate-500 mb-2">
            今月のPL（損益計算書）
          </h2>
          <Row label="可処分所得（手取り・トップライン）" value={pl.disposable} bold />
          <div className="text-xs text-slate-400 text-right">
            （PL対象外）経費精算など {yen(pl.excluded)} は残高に反映・損益には含めず
          </div>
          <hr />
          <Row label="− 固定費" value={pl.fixed} className="text-indigo-500" />
          <Row label="− 変動費" value={pl.variable} className="text-amber-500" />
          <hr />
          <div className="flex items-center justify-between bg-emerald-50 -mx-2 px-3 py-2 rounded-xl">
            <span className="font-bold">月次黒字（貯蓄に回る額）</span>
            <span className="text-2xl font-extrabold text-emerald-600 tabular-nums">
              {yen(pl.surplus)}
            </span>
          </div>
        </section>

        {/* 資産サマリ */}
        <section className="grid grid-cols-3 gap-3">
          <Stat label="総資産" value={assets.total_assets} />
          <Stat label="カード未払い" value={assets.card_unpaid} negative />
          <Stat label="純資産" value={assets.net_assets} accent />
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
          数値は全て transactions / transaction_legs / transfers から集計（残高カラムは持たない）
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
