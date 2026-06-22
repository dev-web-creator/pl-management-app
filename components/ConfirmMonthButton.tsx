"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ConfirmMonthButton({
  period,
  closed,
}: {
  period: string; // 'YYYY-MM-01'
  closed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch("/api/closings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, closed: !closed }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={
        "text-xs px-3 py-1.5 rounded-lg font-semibold disabled:opacity-50 " +
        (closed ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")
      }
    >
      {busy ? "…" : closed ? "確定済み（解除）" : "この月を確定（黒塗り）"}
    </button>
  );
}
