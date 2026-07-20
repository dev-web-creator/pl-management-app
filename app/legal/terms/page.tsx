import Link from "next/link";

export const metadata = { title: "利用規約" };

// 利用規約（テンプレート草案 / ADR-053）。ログイン不要で閲覧可（サインアップ前に読めるように）。
// ※ 法務の専門家ではないためテンプレート。実運用の公開前に必ず専門家の確認を。
export default function TermsPage() {
  return (
    <main className="min-h-screen px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-5 text-slate-700">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">利用規約</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ホーム</Link>
        </header>

        <p className="text-xs text-slate-400">最終更新：2026年7月20日</p>

        <Section n="第1条（適用）">
          本規約は、My PL Ledger の運営者（以下「運営者」）が提供する家計・損益管理サービス「My PL Ledger」（以下「本サービス」）の
          利用に関する条件を、利用者と運営者との間で定めるものです。利用者は本規約に同意のうえ本サービスを利用するものとします。
        </Section>
        <Section n="第2条（アカウント）">
          利用者は Google アカウントによる認証で本サービスを利用します。アカウントの管理責任は利用者が負い、
          第三者への貸与・共有はできません。不正利用が疑われる場合、運営者はアカウントの利用を停止できます。
        </Section>
        <Section n="第3条（サービス内容）">
          本サービスは、利用者が手入力した収支・資産データを記録・集計・可視化する<b>家計管理ツール</b>です。
          本サービスは会計・税務・投資に関する助言を行うものではなく、表示される数値・予測はあくまで参考情報です。
          税務申告・投資判断等は利用者自身の責任で、必要に応じて専門家に相談してください。
        </Section>
        <Section n="第4条（禁止事項）">
          法令・公序良俗に反する行為、本サービスの運営を妨害する行為、他者や運営者の権利を侵害する行為、
          リバースエンジニアリングや不正アクセス等を禁止します。
        </Section>
        <Section n="第5条（データの取り扱い）">
          利用者が入力したデータの取り扱いは<Link href="/legal/privacy" className="text-sky-600 hover:underline">プライバシーポリシー</Link>に定めます。
          利用者はいつでも設定画面から自身のデータをエクスポート（CSV / JSON）できます。
        </Section>
        <Section n="第6条（免責）">
          本サービスは現状有姿で提供され、運営者は特定目的への適合性・正確性・可用性を保証しません。
          本サービスの利用または利用不能によって生じた損害について、運営者は法令で認められる範囲で責任を負いません。
          データはバックアップを推奨します（第5条のエクスポート機能をご利用ください）。
        </Section>
        <Section n="第7条（料金）">
          本サービスは現在、無料で提供しています。将来的に有料プランを導入する場合は、その内容・支払方法・解約・返金の方針を
          本規約に明示し、事前に告知します。
        </Section>
        <Section n="第8条（サービスの変更・終了）">
          運営者は、利用者への合理的な事前告知のうえ、本サービスの内容の変更または提供を終了できます。
          終了時は、利用者がデータをエクスポートできる期間を設けるよう努めます。
        </Section>
        <Section n="第9条（規約の変更）">
          運営者は必要に応じて本規約を変更できます。変更後の規約は本ページへの掲載をもって効力を生じます。
        </Section>
        <Section n="第10条（準拠法・管轄）">
          本規約は日本法に準拠し、本サービスに関する紛争は、運営者の所在地を管轄する裁判所を第一審の専属的合意管轄裁判所とします。
        </Section>
        <p className="text-xs text-slate-400 pt-2">お問い合わせは運営者までご連絡ください。</p>
      </div>
    </main>
  );
}

function Section({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-sm font-bold mb-2">{n}</h2>
      <p className="text-sm leading-relaxed">{children}</p>
    </section>
  );
}
