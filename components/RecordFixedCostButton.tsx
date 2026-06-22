"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 固定費の予定行から「実額で記録」（マスタの予定額をその月の取引化）
export default function RecordFixedCostButton({
  ruleId,
  period,
}: {
  ruleId: number;
  period: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch("/api/recurring/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule_id: ruleId, period }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("記録に失敗: " + d.error);
    } catch (e) {
      alert("通信エラー: " + (e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 hover:bg-indigo-100 disabled:opacity-50"
    >
      {busy ? "…" : "実額で記録"}
    </button>
  );
}
