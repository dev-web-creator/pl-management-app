"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NAV_ITEMS } from "@/lib/nav";

// 機能の表示ON/OFF（ADR-046）：使わないページをナビから隠す
export default function FeatureTogglePanel({ hidden }: { hidden: string[] }) {
  const router = useRouter();
  const [state, setState] = useState<Set<string>>(new Set(hidden));
  const [busy, setBusy] = useState(false);
  const dirty =
    state.size !== hidden.length || hidden.some((h) => !state.has(h));

  function toggle(href: string) {
    setState((s) => {
      const n = new Set(s);
      if (n.has(href)) n.delete(href);
      else n.add(href);
      return n;
    });
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden_pages: Array.from(state) }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(9.5em, 1fr))" }}>
        {NAV_ITEMS.map((n) => {
          const off = state.has(n.href);
          const locked = !!n.always;
          return (
            <button
              key={n.href}
              onClick={() => !locked && toggle(n.href)}
              disabled={locked}
              className={
                "flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg border text-left transition-colors " +
                (locked
                  ? "border-slate-100 bg-slate-50 text-slate-400 cursor-default"
                  : off
                  ? "border-slate-200 bg-slate-100 text-slate-400 line-through"
                  : "border-emerald-200 bg-emerald-50 text-slate-700")
              }
            >
              <span aria-hidden="true" className="shrink-0">{n.emoji}</span>
              <span className="flex-1 min-w-0 truncate whitespace-nowrap">{n.label}</span>
              <span className="text-[9px] font-semibold shrink-0">
                {locked ? "固定" : off ? "OFF" : "ON"}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="text-xs px-3 py-1.5 rounded-lg font-semibold bg-slate-800 text-white disabled:opacity-40 whitespace-nowrap shrink-0"
        >
          {busy ? "…" : "表示設定を保存"}
        </button>
        <span className="text-[11px] text-slate-400">
          OFFにしてもナビから消えるだけで、URL直打ちやデータには影響しません。
        </span>
      </div>
    </div>
  );
}
