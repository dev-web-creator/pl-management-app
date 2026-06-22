"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteTxButton({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("この取引を削除しますか？（残高・PLにも即反映されます）")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/transactions/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        router.refresh(); // サーバーコンポーネントを再取得＝一覧と集計が更新
      } else {
        alert("削除に失敗: " + data.error);
      }
    } catch (e) {
      alert("通信エラー: " + (e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onDelete}
      disabled={busy}
      className="text-xs text-red-400 hover:text-red-600 disabled:opacity-50"
      aria-label="削除"
    >
      {busy ? "…" : "削除"}
    </button>
  );
}
