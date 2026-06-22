"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function BudgetForm({
  period,
  initialIncome,
  initialExpense,
}: {
  period: string; // 'YYYY-MM-01'
  initialIncome: number;
  initialExpense: number;
}) {
  const router = useRouter();
  const [income, setIncome] = useState(initialIncome ? String(initialIncome) : "");
  const [expense, setExpense] = useState(initialExpense ? String(initialExpense) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period,
          income: parseInt(income, 10) || 0,
          expense: parseInt(expense, 10) || 0,
        }),
      });
      const d = await res.json();
      if (!d.ok) setMsg("エラー: " + d.error);
      else {
        setMsg("✓ 目標を保存しました");
        router.refresh();
      }
    } catch (e) {
      setMsg("通信エラー: " + (e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
      <h2 className="text-sm font-semibold text-slate-500">今月の目標を設定</h2>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500">収入の目標</label>
          <input
            inputMode="numeric"
            value={income}
            onChange={(e) => setIncome(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="¥0"
            className="w-full mt-1 border rounded-lg px-3 py-2 text-sm tabular-nums"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">支出の目標（予算）</label>
          <input
            inputMode="numeric"
            value={expense}
            onChange={(e) => setExpense(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="¥0"
            className="w-full mt-1 border rounded-lg px-3 py-2 text-sm tabular-nums"
          />
        </div>
      </div>
      <button
        onClick={save}
        disabled={busy}
        className="w-full bg-slate-900 text-white font-semibold py-2.5 rounded-xl disabled:opacity-50"
      >
        {busy ? "保存中..." : "目標を保存"}
      </button>
      {msg && <p className="text-center text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
