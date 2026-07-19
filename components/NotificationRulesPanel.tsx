"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Rule = { id: number; kind: string; threshold: number; enabled: boolean };

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

// 通知ルールの管理（ADR-042）：一覧のON/OFF・削除＋しきい値の追加
export default function NotificationRulesPanel({ rules }: { rules: Rule[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newThreshold, setNewThreshold] = useState("");
  const [adding, setAdding] = useState(false);

  async function toggle(rule: Rule) {
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/notification-rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(rule: Rule) {
    if (!confirm(`しきい値 ${yen(rule.threshold)} のルールを削除しますか？（送信履歴も消えます）`)) return;
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/notification-rules/${rule.id}`, { method: "DELETE" });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusyId(null);
    }
  }

  async function add() {
    const t = Number(newThreshold);
    if (!Number.isInteger(t) || t <= 0) {
      alert("しきい値は正の整数（円）で入力してください");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/notification-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: t }),
      });
      const d = await res.json();
      if (d.ok) {
        setNewThreshold("");
        router.refresh();
      } else alert("失敗: " + d.error);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <p className="text-sm text-slate-400">通知ルールがありません。下から追加できます。</p>
      ) : (
        <div className="space-y-1.5">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm">
              <span className={r.enabled ? "" : "text-slate-400 line-through"}>
                月の変動費が <b className="tabular-nums">{yen(r.threshold)}</b> を超えたらメール
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggle(r)}
                  disabled={busyId === r.id}
                  className={
                    "text-[11px] px-2.5 py-1 rounded-lg font-semibold disabled:opacity-50 " +
                    (r.enabled
                      ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200")
                  }
                >
                  {r.enabled ? "ON" : "OFF"}
                </button>
                <button
                  onClick={() => remove(r)}
                  disabled={busyId === r.id}
                  className="text-[11px] px-2 py-1 rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-50"
                >
                  削除
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1000}
          placeholder="例: 120000"
          value={newThreshold}
          onChange={(e) => setNewThreshold(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-32 bg-white"
        />
        <span className="text-xs text-slate-500 shrink-0">円で</span>
        <button
          onClick={add}
          disabled={adding || !newThreshold}
          className="text-xs px-3 py-1.5 rounded-lg font-semibold bg-slate-800 text-white disabled:opacity-40 whitespace-nowrap shrink-0"
        >
          {adding ? "…" : "＋ しきい値を追加"}
        </button>
      </div>
    </div>
  );
}
