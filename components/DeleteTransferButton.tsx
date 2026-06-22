"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteTransferButton({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("この資金移動を削除しますか？（残高に即反映されます）")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/transfers/${id}`, { method: "DELETE" });
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
