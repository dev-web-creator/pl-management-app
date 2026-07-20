"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Wallet = { id: number; name: string; type: string };

// 月次ページの収入行から、その月の収入をその場で記録する（ADR-047）。
// 発生日はシート運用に合わせて当月25日（給料日基準）。冪等キー付き（ADR-040）。
export default function QuickIncomeAdd({
  categoryId,
  period, // 'YYYY-MM-01'
  wallets,
}: {
  categoryId: number;
  period: string;
  wallets: Wallet[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);

  async function save() {
    const v = Number(amount);
    if (!Number.isInteger(v) || v <= 0) {
      alert("金額は正の整数（円）で入力してください");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category_id: categoryId,
          type: "income",
          amount: v,
          accrual_date: period.slice(0, 8) + "25",
          wallet_id: walletId,
          memo: "月次ページから入力",
          client_key: crypto.randomUUID(),
        }),
      });
      const d = await res.json();
      if (d.ok) {
        setAmount("");
        setOpen(false);
        router.refresh();
      } else alert("失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100 whitespace-nowrap"
      >
        ＋記録
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input
        type="number"
        inputMode="numeric"
        min={1}
        autoFocus
        placeholder="金額"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="border border-slate-200 rounded px-1.5 py-0.5 text-xs w-24 bg-white tabular-nums"
      />
      <select
        value={walletId}
        onChange={(e) => setWalletId(Number(e.target.value))}
        className="border border-slate-200 rounded px-1 py-0.5 text-[10px] bg-white max-w-24"
      >
        {wallets.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <button
        onClick={save}
        disabled={busy || !amount}
        className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-white disabled:opacity-40 whitespace-nowrap"
      >
        {busy ? "…" : "保存"}
      </button>
      <button
        onClick={() => setOpen(false)}
        className="text-[10px] px-1 py-0.5 rounded text-slate-400 hover:bg-slate-100"
      >
        ×
      </button>
    </span>
  );
}
