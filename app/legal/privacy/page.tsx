import Link from "next/link";

export const metadata = { title: "プライバシーポリシー" };

// プライバシーポリシー（テンプレート草案 / ADR-053）。ログイン不要で閲覧可。
// ※ 実運用前に必ず専門家の確認を。外部送信（Google/Resend）は事実を正直に開示。
export default function PrivacyPage() {
  return (
    <main className="min-h-screen px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-5 text-slate-700">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">プライバシーポリシー</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ホーム</Link>
        </header>

        <p className="text-xs text-slate-400">最終更新：2026年7月20日</p>

        <Section n="1. 収集する情報">
          <ul className="list-disc pl-5 space-y-1">
            <li><b>アカウント情報</b>：Google ログインで取得するメールアドレス・表示名。</li>
            <li><b>利用者が入力する家計データ</b>：収支・残高・口座名・カード・給与明細・メモ・気分など、利用者が手入力した情報。</li>
            <li><b>技術情報</b>：サービス提供に必要な最小限のアクセスログ等。</li>
          </ul>
        </Section>
        <Section n="2. 利用目的">
          収集した情報は、本サービスの提供（記録・集計・可視化・通知）およびサポート・不正防止のためにのみ利用します。
          広告目的での第三者提供や、本人の同意なきデータ販売は行いません。
        </Section>
        <Section n="3. 保管場所">
          データはアプリケーションのホスティング（Vercel）およびデータベース（Neon / PostgreSQL）に保管されます。
          通信は TLS で暗号化されます。
        </Section>
        <Section n="4. 外部サービスへの送信（重要）">
          <ul className="list-disc pl-5 space-y-1">
            <li><b>Google（ログイン）</b>：認証のため Google OAuth を利用します。</li>
            <li>
              <b>Google（給与明細OCR・任意機能）</b>：OCRを有効にした場合、
              給与明細の画像・PDFが読み取りのため Google（Gemini API）へ送信されます。
              無料枠では送信内容がモデル改善に利用される場合があります。画像自体は本サービスのDBには保存しません。
              機微情報のため、この機能の利用は任意です。
            </li>
            <li>
              <b>Resend（メール通知・任意機能）</b>：変動費のしきい値通知メールの送信に外部メール配信（Resend）を利用します。
              送信先は登録メールアドレスです。
            </li>
          </ul>
        </Section>
        <Section n="5. 利用者の権利（エクスポート・削除）">
          利用者は設定画面からいつでも自身のデータをエクスポート（CSV / JSON）できます。
          アカウントおよびデータの削除を希望する場合は運営者までご連絡ください。ご連絡後、合理的な期間内に対応します。
        </Section>
        <Section n="6. 保存期間">
          データは利用者がサービスを利用する間、または削除を依頼するまで保管します。
          退会時には、バックアップ保持期間を除き、利用者のデータを削除します。
        </Section>
        <Section n="7. Cookie">
          ログイン状態の維持のために、必要最小限の Cookie（HTTP Only の署名付きセッション）を使用します。
          広告・トラッキング目的の Cookie は使用しません。
        </Section>
        <Section n="8. 改定">
          本ポリシーは必要に応じて改定し、変更は本ページへの掲載をもって効力を生じます。
        </Section>
        <p className="text-xs text-slate-400 pt-2">お問い合わせ・削除依頼は、My PL Ledger の運営者までご連絡ください。</p>
      </div>
    </main>
  );
}

function Section({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-sm font-bold mb-2">{n}</h2>
      <div className="text-sm leading-relaxed">{children}</div>
    </section>
  );
}
