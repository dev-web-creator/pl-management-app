import Link from "next/link";
import {
  getMonthlyIncomeRows,
  getFixedCostPlanVsActual,
  getVariableLeaves,
  getMonthClosed,
  getWalletOptions,
} from "@/lib/queries";
import { requireAuth } from "@/lib/auth";
import QuickIncomeAdd from "@/components/QuickIncomeAdd";
import RecordFixedCostButton from "@/components/RecordFixedCostButton";
import ConfirmMonthButton from "@/components/ConfirmMonthButton";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const pad = (n: number) => String(n).padStart(2, "0");

// 現運用スプレッドシートの「(FY)月次支出・月次収入」タブの再現（ADR-047）。
// 固定費マスタでONの項目が予定額つきで並び、実額・収入・変動費内訳を月単位でチェックする。
export default async function MonthlyPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  await requireAuth();
  const { m } = await searchParams;
  const now = new Date();
  const period =
    m && /^\d{4}-\d{2}-01$/.test(m) ? m : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const [y, mo] = period.split("-").map(Number);
  const prev = `${mo === 1 ? y - 1 : y}-${pad(mo === 1 ? 12 : mo - 1)}-01`;
  const next = `${mo === 12 ? y + 1 : y}-${pad(mo === 12 ? 1 : mo + 1)}-01`;

  const [income, fixed, leaves, closed, wallets] = await Promise.all([
    getMonthlyIncomeRows(period),
    getFixedCostPlanVsActual(period),
    getVariableLeaves(period),
    getMonthClosed(period),
    getWalletOptions(),
  ]);

  const disposable = income.filter((r) => r.pl_type === "income").reduce((s, r) => s + r.total, 0);
  const fixedTotal = fixed.reduce((s, f) => s + f.effective, 0);
  const variableTotal = leaves.reduce((s, l) => s + l.total, 0);
  const allTotal = fixedTotal + variableTotal;
  const surplus = disposable - allTotal;
  const pct = (v: number) =>
    disposable > 0 ? `${Math.round((v / disposable) * 1000) / 10}%` : "—";

  // 変動費をグループごとにまとめる（シートの グループ→葉 の階層）
  const groups: { name: string; total: number; leaves: typeof leaves }[] = [];
  for (const l of leaves) {
    const g = groups.find((g) => g.name === l.group_name);
    if (g) {
      g.total += l.total;
      g.leaves.push(l);
    } else groups.push({ name: l.group_name, total: l.total, leaves: [l] });
  }

  const incomeWallets = wallets.filter((w) => w.type === "bank" || w.type === "points" || w.type === "prepaid");

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">🧾 月次</h1>
            <span className="flex items-center gap-1 text-sm font-semibold">
              <Link href={`/monthly?m=${prev}`} className="px-2 py-0.5 rounded-lg hover:bg-white" aria-label="前の月">‹</Link>
              {y}年{mo}月
              <Link href={`/monthly?m=${next}`} className="px-2 py-0.5 rounded-lg hover:bg-white" aria-label="次の月">›</Link>
            </span>
            {closed && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-white font-semibold">※確定</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ConfirmMonthButton period={period} closed={closed} />
            <Link href="/" className="text-xs text-sky-600 hover:underline">← サマリ</Link>
          </div>
        </header>

        {/* 収入（月次収入タブ） */}
        <section className={"bg-white rounded-2xl shadow-sm p-5 " + (closed ? "opacity-90" : "")}>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-500">収入</h2>
            <span className="text-sm">
              月次合計(可処分所得) <b className="tabular-nums text-emerald-600">{yen(disposable)}</b>
            </span>
          </div>
          <div className="space-y-1.5">
            {income.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span className={"flex-1 min-w-0 truncate " + (r.pl_type === "excluded" ? "text-slate-400" : "")}>
                  {r.name}
                  {r.pl_type === "excluded" && (
                    <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-400">PL対象外</span>
                  )}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className={"tabular-nums font-semibold w-24 text-right " + (r.total === 0 ? "text-slate-300" : "")}>
                    {yen(r.total)}
                  </span>
                  {!closed && <QuickIncomeAdd categoryId={r.id} period={period} wallets={incomeWallets} />}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            給与の内訳（支給・控除・労働時間）は <Link href="/payslips" className="text-sky-600 hover:underline">給与明細</Link> で管理（OCRは補助）。
          </p>
        </section>

        {/* 固定費（月次支出タブ・固定費セクション） */}
        <section className={"bg-white rounded-2xl shadow-sm p-5 " + (closed ? "opacity-90" : "")}>
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="text-sm font-semibold text-slate-500">固定費（マスタでONの項目）</h2>
            <span className="text-sm">
              合計 <b className="tabular-nums text-red-500">{yen(fixedTotal)}</b>
              <span className="ml-2 text-[11px] text-slate-400">手取り比 {pct(fixedTotal)}</span>
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mb-3">
            予定額はマスタから自動表示。実額が入るとそちらを優先（
            <Link href="/fixed-costs" className="text-sky-600 hover:underline">マスタの管理は設定から</Link>）。
          </p>
          <div className="space-y-1.5">
            {fixed.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex-1 min-w-0 truncate">
                  {f.name}
                  {f.wallet_name && <span className="ml-1 text-[9px] text-slate-400">{f.wallet_name}</span>}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className={"text-[10px] px-1.5 py-0.5 rounded " + (f.is_actual ? "bg-emerald-100 text-emerald-700" : "bg-amber-50 text-amber-600")}>
                    {f.is_actual ? "実績" : "予定"}
                  </span>
                  <span className="tabular-nums font-semibold w-24 text-right">{yen(f.effective)}</span>
                  {!f.is_actual && !closed && <RecordFixedCostButton ruleId={f.id} period={period} />}
                </span>
              </div>
            ))}
            {fixed.length === 0 && (
              <p className="text-sm text-slate-400">この月にアクティブな固定費マスタがありません。</p>
            )}
          </div>
        </section>

        {/* 変動費（月次支出タブ・変動費セクション） */}
        <section className={"bg-white rounded-2xl shadow-sm p-5 " + (closed ? "opacity-90" : "")}>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-500">変動費（日次入力の自動集計）</h2>
            <span className="text-sm">
              合計 <b className="tabular-nums text-red-500">{yen(variableTotal)}</b>
              <span className="ml-2 text-[11px] text-slate-400">手取り比 {pct(variableTotal)}</span>
            </span>
          </div>
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span>{g.name}</span>
                  <span className="tabular-nums">{yen(g.total)}</span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {g.leaves.map((l) => (
                    <div key={l.id} className="flex items-center justify-between text-xs text-slate-500 pl-3">
                      <span className="truncate">{l.name}</span>
                      <span className={"tabular-nums " + (l.total === 0 ? "text-slate-300" : "")}>{yen(l.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-3">
            入力は <Link href="/calendar" className="text-sky-600 hover:underline">カレンダー</Link> か{" "}
            <Link href="/" className="text-sky-600 hover:underline">サマリの「＋取引を入力」</Link> から（1入力で全連動）。
          </p>
        </section>

        {/* 月のまとめ（サマリと同じ計算） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-[10px] text-slate-500">支出合計（固定+変動）</div>
              <div className="text-lg font-extrabold tabular-nums text-red-500">{yen(allTotal)}</div>
              <div className="text-[10px] text-slate-400">手取り比 {pct(allTotal)}</div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500">可処分所得</div>
              <div className="text-lg font-extrabold tabular-nums text-emerald-600">{yen(disposable)}</div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500">月次黒字</div>
              <div className={"text-lg font-extrabold tabular-nums " + (surplus >= 0 ? "text-sky-600" : "text-red-500")}>
                {surplus < 0 ? "−" : ""}
                {yen(Math.abs(surplus))}
              </div>
            </div>
          </div>
          <p className="text-center text-[11px] text-slate-400 mt-2">
            サマリ（📊）はこの月次の数字と同じ取引データから集計されています（シートの「サマリは月次から参照」と同じ構造）。
          </p>
        </section>
      </div>
    </main>
  );
}
