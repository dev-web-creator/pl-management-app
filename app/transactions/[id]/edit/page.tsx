import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getTransactionForEdit,
  getInputCategories,
  getWalletOptions,
} from "@/lib/queries";
import AddTransactionForm from "@/components/AddTransactionForm";

export const dynamic = "force-dynamic";

export default async function EditTransactionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const txId = Number(id);
  if (!Number.isInteger(txId) || txId <= 0) notFound();

  const [tx, categories, wallets] = await Promise.all([
    getTransactionForEdit(txId),
    getInputCategories(),
    getWalletOptions(),
  ]);
  if (!tx) notFound();

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-md mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold">取引の編集</h1>
          <Link href="/transactions" className="text-xs text-sky-600 hover:underline">
            ← 取引一覧
          </Link>
        </header>
        <AddTransactionForm
          categories={categories}
          wallets={wallets}
          today={tx.date}
          edit={{
            id: tx.id,
            type: tx.type,
            amount: tx.amount,
            categoryId: tx.category_id,
            walletId: tx.wallet_id ?? wallets[0]?.id ?? 0,
            date: tx.date,
            memo: tx.memo ?? "",
            legCount: tx.leg_count,
          }}
        />
      </div>
    </main>
  );
}
