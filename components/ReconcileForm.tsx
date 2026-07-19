"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReconcileRow } from "@/lib/queries";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

const TYPE_LABEL: Record<string, string> = {
  bank: "銀行",
  prepaid: "プリペイド",
  points: "ポイント",
  crypto: "暗号資産",
  credit_card: "クレカ",
};

export default function ReconcileForm({ rows, today }: { rows: ReconcileRow[]; today: string }) {
  const router = useRouter();
  // 入力中の実残高（初期値は直近の記録があればそれ）
  const [vals, setVals] = useState<Record<number, string>>(
    Object.fromEntries(rows.map((r) => [r.id, r.actual != null ? String(r.actual) : ""]))
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setMsg(null);
    const items = rows
      .filter((r) => vals[r.id] !== "" && vals[r.id] != null)
      .map((r) => ({ wallet_id: r.id, actual_balance: parseInt(vals[r.id], 10) || 0 }));
    if (items.length === 0) {
      setMsg("実残高を入力してください");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ as_of_date: today, items }),
      });
      const d = await res.json();
      if (!d.ok) setMsg("エラー: " + d.error);
      else {
        setMsg(`✓ ${d.count}件を記録しました（${today}）`);
        router.refresh();
      }
    } catch (e) {
      setMsg("通信エラー: " + (e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
      <p className="text-[11px] text-slate-400">
        各ウォレットの「実際の残高」を入力すると、自動算出値との差を表示します。差が出たら入力漏れの可能性。基準日：{today}
      </p>
      <div className="space-y-2">
        {rows.map((r) => {
          const v = vals[r.id];
          const actualNum = v !== "" && v != null ? parseInt(v, 10) || 0 : null;
          const diff = actualNum != null ? actualNum - r.computed : null;
          return (
            <div key={r.id} className="flex items-center gap-2 text-sm border-b pb-2">
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  {r.name}
                  <span className="text-[10px] text-slate-400 ml-1">{TYPE_LABEL[r.type] ?? r.type}</span>
                </div>
                <div className="text-[11px] text-slate-400 tabular-nums">
                  自動算出 {yen(r.computed)}
                  {r.as_of && <span className="ml-2">前回記録 {r.as_of}</span>}
                </div>
              </div>
              <input
                inputMode="numeric"
                value={v ?? ""}
                onChange={(e) => setVals({ ...vals, [r.id]: e.target.value.replace(/[^0-9]/g, "") })}
                placeholder="実残高"
                className="w-28 border rounded-lg px-2 py-1.5 text-sm text-right tabular-nums"
              />
              <div className="w-24 text-right text-xs tabular-nums">
                {diff == null ? (
                  <span className="text-slate-300">—</span>
                ) : diff === 0 ? (
                  <span className="text-emerald-600">一致 ✓</span>
                ) : (
                  <span className="text-red-500">差 {diff > 0 ? "+" : "−"}{yen(Math.abs(diff))}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={save}
        disabled={busy}
        className="w-full bg-slate-900 text-white font-semibold py-2.5 rounded-xl disabled:opacity-50"
      >
        {busy ? "保存中..." : "実残高を記録する"}
      </button>
      {msg && <p className="text-center text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
