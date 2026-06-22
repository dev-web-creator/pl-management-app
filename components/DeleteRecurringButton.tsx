"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteRecurringButton({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("この固定費マスタを削除しますか？（解約したいだけなら『終了年月』をセットしてください）")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/recurring/${id}`, { method: "DELETE" });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("削除に失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onDelete}
      disabled={busy}
      className="text-xs text-red-400 hover:text-red-600 disabled:opacity-50"
    >
      {busy ? "…" : "削除"}
    </button>
  );
}
