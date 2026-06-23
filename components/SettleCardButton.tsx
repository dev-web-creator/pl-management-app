"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SettleCardButton({
  cardId,
  closeKey,
  amount,
  payDate,
}: {
  cardId: number;
  closeKey: string; // 'YYYY-MM-DD'（締め日）
  amount: number;
  payDate: string; // 'YYYY-MM-DD'（引落日）
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (!confirm(`このサイクルを引き落とし実行（消込）しますか？\n銀行→カードへ ¥${amount.toLocaleString("ja-JP")} を移し、未払いを消し込みます。`))
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/cards/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_id: cardId, close_key: closeKey, amount, pay_date: payDate }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("消込に失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="text-[10px] px-2 py-1 rounded bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50"
    >
      {busy ? "…" : "引き落とし実行"}
    </button>
  );
}
