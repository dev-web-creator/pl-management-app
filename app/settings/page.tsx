import Link from "next/link";
import { getUserSettings, getNotificationRules, getNotificationLog } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";
import { notifyEnabled } from "@/lib/notify";
import FySettingForm from "@/components/FySettingForm";
import NotificationRulesPanel from "@/components/NotificationRulesPanel";

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
