import Link from "next/link";
import { getCardLegs, type CardLeg } from "@/lib/queries";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m:1-12

type Cycle = { closeY: number; closeM: number; closeD: number; payY: number; payM: number; payD: number };

// 取引の発生日とカード設定から、属する請求サイクル（締め日・引落日）を判定（ADR-023）
function cycleOf(dateStr: string, c: CardLeg): Cycle {
  const [y, m, d] = dateStr.split("-").map(Number);
  let closeY = y;
  let closeM = m;
  if (!c.closing_eom && c.closing_day != null) {
    if (d > c.closing_day) {
      closeM = m + 1;
      if (closeM > 12) {
        closeM = 1;
        closeY = y + 1;
      }
    }
  }
  const closeD = c.closing_eom ? lastDay(closeY, closeM) : Math.min(c.closing_day ?? 1, lastDay(closeY, closeM));
  let payY = closeY;
  let payM = closeM + (c.payment_month_offset ?? 1);
  while (payM > 12) {
    payM -= 12;
    payY += 1;
  }
  const payD = c.payment_eom ? lastDay(payY, payM) : Math.min(c.payment_day ?? 1, lastDay(payY, payM));
  return { closeY, closeM, closeD, payY, payM, payD };
}

export default async function CardsPage() {
  const legs = await getCardLegs();
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  // カードごとにまとめる
  const cards = new Map<number, { info: CardLeg; cycles: Map<string, { cyc: Cycle; total: number; items: CardLeg[] }> }>();
  for (const leg of legs) {
    if (!cards.has(leg.card_id)) cards.set(leg.card_id, { info: leg, cycles: new Map() });
    const card = cards.get(leg.card_id)!;
    const cyc = cycleOf(leg.date, leg);
    const key = `${cyc.closeY}-${pad(cyc.closeM)}-${pad(cyc.closeD)}`;
    if (!card.cycles.has(key)) card.cycles.set(key, { cyc, total: 0, items: [] });
    const c = card.cycles.get(key)!;
    c.total += leg.amount;
    c.items.push(leg);
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">クレジットカード（請求サイクル）</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ダッシュボード</Link>
        </header>

        {cards.size === 0 ? (
          <p className="text-sm text-slate-400 bg-white rounded-2xl shadow-sm p-5">
            クレカでの支払いがまだありません。
          </p>
        ) : (
          Array.from(cards.values()).map(({ info, cycles }) => {
            const sorted = Array.from(cycles.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1)); // 新しい締め順
            // 次回引落＝引落日が今日以降で最も近いサイクル
            const upcoming = sorted
              .map(([, v]) => v)
              .filter((v) => `${v.cyc.payY}-${pad(v.cyc.payM)}-${pad(v.cyc.payD)}` >= todayKey)
              .sort((a, b) => (`${a.cyc.payY}-${pad(a.cyc.payM)}-${pad(a.cyc.payD)}` < `${b.cyc.payY}-${pad(b.cyc.payM)}-${pad(b.cyc.payD)}` ? -1 : 1))[0];
            return (
              <section key={info.card_id} className="bg-white rounded-2xl shadow-sm p-5">
                <div className="flex items-baseline justify-between mb-1">
                  <h2 className="font-bold">{info.card_name}</h2>
                  <span className="text-[11px] text-slate-400">引落先：{info.settlement_name ?? "—"}</span>
                </div>
                <p className="text-[11px] text-slate-400 mb-3">
                  締め：{info.closing_eom ? "毎月末" : `毎月${info.closing_day}日`} ／ 引落：
                  {info.payment_eom ? "末日" : `${info.payment_day}日`}（締めの{info.payment_month_offset}ヶ月後）
                </p>

                <div className="space-y-3">
                  {sorted.map(([key, v]) => {
                    const isUpcoming = upcoming && v === upcoming;
                    return (
                      <div key={key} className={"border rounded-xl p-3 " + (isUpcoming ? "border-sky-300 bg-sky-50/40" : "")}>
                        <div className="flex items-center justify-between">
                          <div className="text-sm">
                            <span className="font-semibold tabular-nums">
                              {v.cyc.closeM}/{v.cyc.closeD} 締め
                            </span>
                            <span className="text-slate-400"> → </span>
                            <span className="tabular-nums">
                              {v.cyc.payM}/{v.cyc.payD} 引落
                            </span>
                            {isUpcoming && <span className="text-[10px] bg-sky-500 text-white px-1.5 py-0.5 rounded ml-2">次回引落</span>}
                          </div>
                          <span className="font-bold tabular-nums">{yen(v.total)}</span>
                        </div>
                        <div className="mt-2 space-y-0.5">
                          {v.items.map((it) => (
                            <div key={it.tx_id} className="flex justify-between text-xs text-slate-500">
                              <span>
                                {it.date.slice(5)} {it.category}
                                {it.memo && <span className="text-slate-400"> / {it.memo}</span>}
                              </span>
                              <span className="tabular-nums">{yen(it.amount)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
        <p className="text-center text-xs text-slate-400">
          発生日＋カードの締め日から請求サイクルを自動判定（取引は1件のまま・二重入力なし／ADR-023）。
        </p>
      </div>
    </main>
  );
}
