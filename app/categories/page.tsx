import Link from "next/link";
import { getCategoriesForManagement } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";
import CategoryManager from "@/components/CategoryManager";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  await requireAuth();
  const categories = await getCategoriesForManagement();

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">🗂️ 費目（カテゴリ）の管理</h1>
          <Link href="/settings" className="text-xs text-sky-600 hover:underline">← 設定</Link>
        </header>

        <section className="bg-white rounded-2xl shadow-sm p-5">
          <p className="text-[11px] text-slate-500 mb-4">
            収入・支出の費目を自由に追加・改名できます。変動費は「食費」の中に「朝食」「昼食」…のように
            グループ化も可能です。取引で使っている費目は削除できないので「無効化」（選択肢から隠す）してください。
          </p>
          <CategoryManager categories={categories} />
        </section>
      </div>
    </main>
  );
}
