import Link from "next/link";
import { getReconcileData } from "@/lib/queries";
import ReconcileForm from "@/components/ReconcileForm";

export const dynamic = "force-dynamic";

const pad = (n: number) => String(n).padStart(2, "0");

export default async function ReconcilePage() {
  const rows = await getReconcileData();
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">残高の照合（リコンサイル）</h1>
          <Link href="/assets" className="text-xs text-sky-600 hover:underline">← 資産</Link>
        </header>
        <ReconcileForm rows={rows} today={today} />
        <p className="text-center text-xs text-slate-400">
          普段は自動算出を信頼。月末などにここで実残高と突き合わせ、差があれば入力漏れを探す運用です（ADR-027）。
        </p>
      </div>
    </main>
  );
}
