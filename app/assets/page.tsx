import Link from "next/link";
import {
  getAssets,
  getAssetTrend,
  getAssetBreakdown,
  getDividendTrend,
  getAssetTarget,
  getCryptoWallets,
} from "@/lib/queries";
import { requireAuth } from "@/lib/auth";
import CryptoPanel from "@/components/CryptoPanel";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const man = (n: number) => (n / 10000).toFixed(0) + "万";
const pad = (n: number) => String(n).padStart(2, "0");

const TYPE_LABEL: Record<string, string> = {
  bank: "銀行",
  prepaid: "プリペイド",
  points: "ポイント",
  cash: "現金",
  crypto: "暗号資産",
};

export default async function AssetsPage() {
  await requireAuth();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const [assets, trend, breakdown, dividends, assetTarget, cryptos] = await Promise.all([
    getAssets(),
    getAssetTrend(),
    getAssetBreakdown(),
    getDividendTrend(),
    getAssetTarget(thisMonth),
    getCryptoWallets(),
  ]);
  const achievePct = assetTarget > 0 ? Math.round((assets.total_assets / assetTarget) * 100) : null;

  const maxAsset = Math.max(1, ...trend.map((t) => t.total_assets));
  const breakdownTotal = breakdown.reduce((s, b) => s + b.total, 0) || 1;
  const palette = ["#0ea5e9", "#6366f1", "#10b981", "#f59e0b", "#94a3b8"];

  // インラインSVG 棒グラフ（総資産の月次推移）
  const W = 640;
  const H = 200;
  const padX = 36;
  const padY = 20;
  const n = trend.length;
  const bw = n > 0 ? (W - padX * 2) / n : 0;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">資産ダッシュボード</h1>
          <div className="flex items-center gap-3 text-xs">
            <Link href="/reconcile" className="text-sky-600 hover:underline">残高照合</Link>
            <Link href="/" className="text-sky-600 hover:underline">← ダッシュボード</Link>
          </div>
        </header>

        {/* 現在のサマリ */}
        <section className="grid grid-cols-3 gap-3">
          <Stat label="総資産" value={assets.total_assets} />
          <Stat label="カード未払い" value={assets.card_unpaid} negative />
          <Stat label="純資産" value={assets.net_assets} accent />
        </section>

        {/* 資産形成の目標達成率 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-500">資産形成の目標（今月）</h2>
            <Link href={`/budget?m=${thisMonth}`} className="text-[11px] text-sky-600 hover:underline">
              目標を設定 ›
            </Link>
          </div>
          {assetTarget > 0 ? (
            <>
              <div className="flex items-baseline justify-between text-sm mb-2">
                <span className="text-slate-500">
                  現在 <span className="font-bold text-slate-900 tabular-nums">{yen(assets.total_assets)}</span>
                  <span className="text-slate-400"> / 目標 {yen(assetTarget)}</span>
                </span>
                <span className={"font-bold tabular-nums " + ((achievePct ?? 0) >= 100 ? "text-emerald-600" : "text-slate-700")}>
                  達成率 {achievePct}%
                </span>
              </div>
              <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={(achievePct ?? 0) >= 100 ? "h-full bg-emerald-500" : "h-full bg-sky-400"}
                  style={{ width: `${Math.min(achievePct ?? 0, 100)}%` }}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">
              目標が未設定です。「目標を設定 ›」から総資産の目標額を入れると達成率が出ます。
            </p>
          )}
        </section>

        {/* 総資産の推移 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">総資産の推移（月末時点）</h2>
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 520 }}>
              {trend.map((t, i) => {
                const h = ((H - padY * 2) * t.total_assets) / maxAsset;
                const x = padX + i * bw + bw * 0.15;
                const y = H - padY - h;
                return (
                  <g key={t.month}>
                    <rect x={x} y={y} width={bw * 0.7} height={Math.max(0, h)} rx={3} fill="#0ea5e9" />
                    <text x={x + bw * 0.35} y={y - 4} textAnchor="middle" fontSize="9" fill="#64748b">
                      {man(t.total_assets)}
                    </text>
                    <text x={x + bw * 0.35} y={H - 6} textAnchor="middle" fontSize="8" fill="#94a3b8">
                      {t.month.slice(2)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            取引・振替の累計から各月末の総資産を算出（残高スナップショットは保持せず計算で再現）。
          </p>
        </section>

        {/* 資産の内訳（種別別） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">資産の内訳（種別別・現在）</h2>
          {breakdown.length === 0 ? (
            <p className="text-sm text-slate-400">資産がありません。</p>
          ) : (
            <>
              <div className="flex h-5 rounded-full overflow-hidden mb-3">
                {breakdown.map((b, i) => (
                  <div
                    key={b.type}
                    style={{ width: `${(b.total / breakdownTotal) * 100}%`, background: palette[i % palette.length] }}
                  />
                ))}
              </div>
              <div className="space-y-1.5">
                {breakdown.map((b, i) => (
                  <div key={b.type} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: palette[i % palette.length] }} />
                      {TYPE_LABEL[b.type] ?? b.type}
                    </span>
                    <span className="tabular-nums font-semibold">{yen(b.total)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {/* 暗号資産（ADR-043） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">₿ 暗号資産（評価額の手入力）</h2>
          <CryptoPanel wallets={cryptos} today={today} />
          <p className="text-[11px] text-slate-400 mt-3">
            価格APIには依存せず、その時の評価額を円で手入力する方式（実現主義・ADR-014と整合）。
            最新の評価額が総資産・純資産・推移グラフに反映されます。購入は「振替（銀行→銘柄）」、売却益は「投資収益」で記録。
          </p>
        </section>

        {/* 配当の推移 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">配当・分配金の推移</h2>
          {dividends.length === 0 ? (
            <p className="text-sm text-slate-400">
              まだ配当の記録がありません。収入入力で「投資収益(配当)」カテゴリを使うとここに集計されます。
            </p>
          ) : (
            <div className="space-y-1.5">
              {dividends.map((d) => (
                <div key={d.month} className="flex justify-between text-sm">
                  <span className="tabular-nums text-slate-500">{d.month}</span>
                  <span className="tabular-nums font-semibold text-emerald-600">{yen(d.total)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
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
        {"¥" + value.toLocaleString("ja-JP")}
      </div>
    </div>
  );
}
