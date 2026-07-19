"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// FY開始月の設定（ADR-017）
export default function FySettingForm({ current }: { current: number }) {
  const router = useRouter();
  const [month, setMonth] = useState(current);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fiscal_year_start_month: month }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <select
        value={month}
        onChange={(e) => setMonth(Number(e.target.value))}
        className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white"
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <option key={m} value={m}>
            {m}月はじまり
          </option>
        ))}
      </select>
      <button
        onClick={save}
        disabled={busy || month === current}
        className="text-xs px-3 py-1.5 rounded-lg font-semibold bg-slate-800 text-white disabled:opacity-40 whitespace-nowrap shrink-0"
      >
        {busy ? "…" : "保存"}
      </button>
      {month !== current && (
        <span className="text-[11px] text-slate-400">年次（/year）・予実のFY境界が変わります</span>
      )}
    </div>
  );
}
