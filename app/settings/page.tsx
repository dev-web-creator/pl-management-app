import Link from "next/link";
import { getUserSettings, getNotificationRules, getNotificationLog } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";
import { notifyEnabled } from "@/lib/notify";
import FySettingForm from "@/components/FySettingForm";
import NotificationRulesPanel from "@/components/NotificationRulesPanel";
import FeatureTogglePanel from "@/components/FeatureTogglePanel";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

export default async function SettingsPage() {
  await requireAuth();
  const [settings, rules, log] = await Promise.all([
    getUserSettings(),
    getNotificationRules(),
    getNotificationLog(10),
  ]);
  const mailReady = notifyEnabled();

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">⚙️ 設定</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ダッシュボード</Link>
        </header>

        {/* 機能の表示ON/OFF（ADR-046） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">🧩 機能の表示（使わないページをナビから隠す）</h2>
          <FeatureTogglePanel hidden={settings.hidden_pages} />
        </section>

        {/* マスタ管理（ADR-047：初期設定・メンテナンス系の入り口） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">🔧 マスタ管理</h2>
          <div className="space-y-2">
            <Link
              href="/wallets"
              className="flex items-center justify-between text-sm px-3 py-2.5 rounded-xl border border-slate-100 hover:bg-slate-50"
            >
              <span>🏦 口座・カード・電子マネー（決済手段の登録）</span>
              <span className="text-slate-400">›</span>
            </Link>
            <Link
              href="/categories"
              className="flex items-center justify-between text-sm px-3 py-2.5 rounded-xl border border-slate-100 hover:bg-slate-50"
            >
              <span>🗂️ 費目（カテゴリ）の追加・改名</span>
              <span className="text-slate-400">›</span>
            </Link>
            <Link
              href="/fixed-costs"
              className="flex items-center justify-between text-sm px-3 py-2.5 rounded-xl border border-slate-100 hover:bg-slate-50"
            >
              <span>📌 固定費マスタ（追加・金額変更・解約）</span>
              <span className="text-slate-400">›</span>
            </Link>
            <Link
              href="/assets"
              className="flex items-center justify-between text-sm px-3 py-2.5 rounded-xl border border-slate-100 hover:bg-slate-50"
            >
              <span>₿ 暗号資産の銘柄追加・評価額（資産ページ内）</span>
              <span className="text-slate-400">›</span>
            </Link>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            固定費マスタでONの項目は、毎月「🧾 月次」に予定額つきで自動表示されます。
          </p>
        </section>

        {/* データのエクスポート（ADR-053） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">💾 データのエクスポート</h2>
          <div className="space-y-2">
            <a
              href="/api/export/transactions"
              download
              className="flex items-center justify-between text-sm px-3 py-2.5 rounded-xl border border-slate-100 hover:bg-slate-50"
            >
              <span>📄 取引をCSVで書き出し（Excelで開けます）</span>
              <span className="text-slate-400">↓</span>
            </a>
            <a
              href="/api/export/all"
              download
              className="flex items-center justify-between text-sm px-3 py-2.5 rounded-xl border border-slate-100 hover:bg-slate-50"
            >
              <span>🗄️ 全データをJSONで書き出し（バックアップ用）</span>
              <span className="text-slate-400">↓</span>
            </a>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            あなたのデータはいつでも取り出せます。CSVは家計の分析やExcelでの加工に、JSONは全項目のバックアップに。
          </p>
        </section>

        {/* 使い方ガイド */}
        <Link
          href="/guide"
          className="block bg-white rounded-2xl shadow-sm p-5 hover:bg-slate-50"
        >
          <span className="text-sm font-semibold text-slate-600">📖 使い方ガイド</span>
          <span className="block text-[11px] text-slate-400 mt-1">初期設定から毎月の運用・振り返りまでの流れ</span>
        </Link>

        {/* 規約・プライバシー */}
        <div className="flex items-center justify-center gap-4 text-[11px] text-slate-400">
          <Link href="/legal/terms" className="hover:underline">利用規約</Link>
          <span>·</span>
          <Link href="/legal/privacy" className="hover:underline">プライバシーポリシー</Link>
        </div>

        {/* FY開始月（ADR-017） */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">会計年度（FY）の開始月</h2>
          <FySettingForm current={settings.fiscal_year_start_month} />
        </section>

        {/* 通知（ADR-042） */}
        <section className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-500">🔔 メール通知ルール</h2>
            <span
              className={
                "text-[10px] px-2 py-0.5 rounded-full font-semibold " +
                (mailReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")
              }
            >
              {mailReady ? "送信有効" : "RESEND_API_KEY 未設定（ルールは保存されます）"}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            月の変動費（発生主義）がしきい値に到達した瞬間に、ログイン中のメールアドレス
            {settings.email ? <b>（{settings.email}）</b> : "（未設定）"}へ通知します。
            同じしきい値の通知は<b>月1回だけ</b>です。
          </p>
          <NotificationRulesPanel rules={rules} />
        </section>

        {/* 送信履歴 */}
        <section className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-500 mb-3">送信履歴（直近10件）</h2>
          {log.length === 0 ? (
            <p className="text-sm text-slate-400">まだ送信履歴はありません。</p>
          ) : (
            <div className="space-y-1.5">
              {log.map((l, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span>
                    {l.period}：変動費 <b className="tabular-nums">{yen(l.threshold)}</b> 到達
                  </span>
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {l.sent_to ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="text-center text-xs text-slate-400">
          通知の仕組み：取引の保存時に当月合計を判定 → 未通知のしきい値だけメール（ADR-042）。
        </p>
      </div>
    </main>
  );
}
