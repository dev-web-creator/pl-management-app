import Link from "next/link";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-6 h-6 grid place-items-center rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold shrink-0">
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="font-semibold text-sm">{title}</h3>
        <div className="text-sm text-slate-600 mt-1 space-y-1">{children}</div>
      </div>
    </div>
  );
}

export default async function GuidePage() {
  await requireAuth();
  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">📖 使い方ガイド</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← サマリ</Link>
        </header>

        <section className="bg-white rounded-2xl shadow-sm p-5">
          <p className="text-sm text-slate-600">
            このアプリは「手取り → 固定費 → 変動費 → 月次黒字」を、企業の損益計算書（PL）のように毎月見える化する家計簿です。
            すべて手入力ですが、<b>1回の入力が残高・PL・資産・分析すべてに連動</b>します。
          </p>
        </section>

        {/* 初期設定 */}
        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-500">① 最初の設定（1回だけ・⚙️設定 &gt; マスタ管理）</h2>
          <Step n="1" title="🏦 口座・カード・電子マネーを登録">
            <p>普段使う銀行・クレジットカード・電子マネー・ポイントを登録します。クレカは締め日・支払日・引落先を入れると、請求サイクルと引落予定が自動計算されます。</p>
            <Link href="/wallets" className="text-sky-600 hover:underline text-xs">→ 口座・カードの管理へ</Link>
          </Step>
          <Step n="2" title="🗂️ 費目（カテゴリ）を自分用に調整">
            <p>初期費目が入っています。使わないものは無効化、必要なものは追加・改名。変動費は「食費」の中に「朝食」…のようにグループ化できます。</p>
            <Link href="/categories" className="text-sky-600 hover:underline text-xs">→ 費目の管理へ</Link>
          </Step>
          <Step n="3" title="📌 固定費を登録">
            <p>家賃・保険・サブスクなど毎月ほぼ固定の支出を登録します。ここで登録した「予定額」が毎月の月次に自動で並びます（解約は終了年月をセットするだけ）。</p>
            <Link href="/fixed-costs" className="text-sky-600 hover:underline text-xs">→ 固定費マスタへ</Link>
          </Step>
          <Step n="4" title="⚙️ 会計年度（FY）の開始月を設定">
            <p>4月始まりなど、あなたの年度の区切りに合わせます（年次・5か年PLの集計に反映）。</p>
            <Link href="/settings" className="text-sky-600 hover:underline text-xs">→ 設定へ</Link>
          </Step>
        </section>

        {/* 毎日・毎月の運用 */}
        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-500">② 毎日・毎月の運用</h2>
          <Step n="毎日" title="支出をその場で記録">
            <p><Link href="/" className="text-sky-600 hover:underline">サマリ</Link>の「＋取引を入力」か <Link href="/calendar" className="text-sky-600 hover:underline">カレンダー</Link>から、金額・費目・決済手段を入れるだけ。決済手段を選ぶことで残高にも自動反映されます。</p>
          </Step>
          <Step n="給料日" title="💰 給与明細を登録">
            <p><Link href="/payslips" className="text-sky-600 hover:underline">給与</Link>で支給・控除を入力（画像・PDFがあれば📷読み取りも）。手取りが月次の「給与収入」と口座残高に自動連動します。</p>
          </Step>
          <Step n="毎月" title="🧾 月次でチェック・締める">
            <p><Link href="/monthly" className="text-sky-600 hover:underline">月次</Link>で収入・固定費・変動費と手取り比を確認。固定費は実額が違えば「実額で記録」。月が終わったら「確定（黒塗り）」。</p>
          </Step>
          <Step n="随時" title="🔄 振替・カード引き落とし">
            <p>口座間の移動やチャージは<Link href="/transfers" className="text-sky-600 hover:underline">振替</Link>で（PLには出ません）。カードの引き落としは<Link href="/cards" className="text-sky-600 hover:underline">カード</Link>から1タップで消し込めます。</p>
          </Step>
        </section>

        {/* 振り返り */}
        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-500">③ 振り返り・分析</h2>
          <Step n="📊" title="サマリ / 分析 / 年次 / 5か年">
            <p><Link href="/" className="text-sky-600 hover:underline">サマリ</Link>で今月のPLと総資産、<Link href="/analytics" className="text-sky-600 hover:underline">分析</Link>で月比較、<Link href="/year" className="text-sky-600 hover:underline">年次</Link>でFY集計、<Link href="/forecast" className="text-sky-600 hover:underline">5か年</Link>で将来予測。</p>
          </Step>
          <Step n="🐷" title="資産・目標">
            <p><Link href="/assets" className="text-sky-600 hover:underline">資産</Link>で総資産の推移と暗号資産の評価額、<Link href="/vision" className="text-sky-600 hover:underline">目標</Link>で人生設計のメモ。</p>
          </Step>
          <Step n="🔔" title="通知">
            <p><Link href="/settings" className="text-sky-600 hover:underline">設定</Link>で「今月の変動費が◯万円を超えたらメール」を設定できます。使わない画面は同じく設定からナビ非表示にできます。</p>
          </Step>
        </section>

        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-2">💡 考え方のコツ</h2>
          <ul className="text-sm text-slate-600 space-y-1.5 list-disc pl-5">
            <li>クレカ払いは「買った日」に費用計上（発生主義）。引き落としは振替で別に処理します。</li>
            <li>税金・社会保険料は給与明細の「控除」で管理し、支出には二重計上しません。</li>
            <li>投資の元本移動・株購入は損益に出さず、売却益・配当など「実現した利益」だけ収入にします。</li>
            <li>残高は取引から自動計算。ズレたら<Link href="/reconcile" className="text-sky-600 hover:underline">残高照合</Link>で入力漏れを探せます。</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
