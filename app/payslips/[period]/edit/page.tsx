import Link from "next/link";
import { notFound } from "next/navigation";
import { getPayslipForEdit } from "@/lib/queries";
import PayslipForm from "@/components/PayslipForm";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function EditPayslipPage({
  params,
}: {
  params: Promise<{ period: string }>;
}) {
  await requireAuth();
  const { period } = await params;
  if (!/^\d{4}-\d{2}$/.test(period)) notFound();

  const data = await getPayslipForEdit(period);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 px-4 py-6">
      <div className="max-w-md mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold">給与明細 ・ {period}</h1>
          <Link href="/payslips" className="text-xs text-sky-600 hover:underline">
            ← 給与明細一覧
          </Link>
        </header>
        <PayslipForm initial={data} />
      </div>
    </main>
  );
}
