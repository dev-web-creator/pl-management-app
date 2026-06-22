import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getRecurringRuleForEdit,
  getFixedCostCategories,
  getWalletOptions,
} from "@/lib/queries";
import RecurringForm from "@/components/RecurringForm";

export const dynamic = "force-dynamic";

export default async function EditRecurringPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) notFound();

  const [rule, cats, wallets] = await Promise.all([
    getRecurringRuleForEdit(ruleId),
    getFixedCostCategories(),
    getWalletOptions(),
  ]);
  if (!rule) notFound();

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-md mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold">固定費の編集</h1>
          <Link href="/fixed-costs" className="text-xs text-sky-600 hover:underline">
            ← 固定費一覧
          </Link>
        </header>
        <RecurringForm
          categories={cats}
          wallets={wallets}
          defaultMonth={rule.start_month}
          edit={{
            id: rule.id,
            name: rule.name,
            amount: rule.amount,
            categoryId: rule.category_id,
            walletId: rule.settlement_wallet_id,
            startMonth: rule.start_month,
            endMonth: rule.end_month,
            billingDay: rule.billing_day,
          }}
        />
      </div>
    </main>
  );
}
