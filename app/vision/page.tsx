import Link from "next/link";
import { getVisionNote } from "@/lib/queries";
import VisionForm from "@/components/VisionForm";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function VisionPage() {
  await requireAuth();
  const content = await getVisionNote();
  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">ビジョン・目標</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">← ダッシュボード</Link>
        </header>
        <p className="text-[11px] text-slate-500">
          30歳目標・やりたいこと・KPI（読書50冊/旅行2回）・上限予算など、自由に書ける箱です（まずは入力できる場所だけ）。
          将来、ここの項目を予実や資産目標と連動させることもできます。
        </p>
        <VisionForm initial={content} />
      </div>
    </main>
  );
}
