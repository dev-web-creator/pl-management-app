"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type CryptoWallet = { id: number; name: string; value: number | null; as_of: string | null };

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

// 暗号資産の管理（ADR-043）：銘柄（ウォレット）の追加＋評価額の手入力更新
// 価格APIには依存しない。評価額は balance_snapshots に upsert（今日の日付）。
export default function CryptoPanel({ wallets, today }: { wallets: CryptoWallet[]; today: string }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  async function saveValue(w: CryptoWallet) {
    const v = Number(values[w.id]);
    if (!Number.isFinite(v) || v < 0) {
      alert("評価額は0以上の数値（円）で入力してください");
      return;
    }
    setBusyId(w.id);
    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ as_of_date: today, items: [{ wallet_id: w.id, actual_balance: v }] }),
      });
      const d = await res.json();
      if (d.ok) {
        setValues((s) => ({ ...s, [w.id]: "" }));
        router.refresh();
      } else alert("失敗: " + d.error);
    } finally {
      setBusyId(null);
    }
  }

  async function addWallet() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      const res = await fetch("/api/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type: "crypto" }),
      });
      const d = await res.json();
      if (d.ok) {
        setNewName("");
        router.refresh();
      } else alert("失敗: " + d.error);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-3">
      {wallets.length === 0 ? (
        <p className="text-sm text-slate-400">
          まだ銘柄がありません。下から追加してください（例: bitFlyer ETH）。
        </p>
      ) : (
        <div className="space-y-2">
          {wallets.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-28">
                {w.name}
                <span className="block text-[10px] text-slate-400">
                  {w.as_of ? `評価日 ${w.as_of}` : "評価額 未入力"}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums font-semibold w-24 text-right">
                  {w.value != null ? yen(w.value) : "—"}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="評価額(円)"
                  value={values[w.id] ?? ""}
                  onChange={(e) => setValues((s) => ({ ...s, [w.id]: e.target.value }))}
                  className="border border-slate-200 rounded-lg px-2 py-1 text-sm w-28 bg-white"
                />
                <button
                  onClick={() => saveValue(w)}
                  disabled={busyId === w.id || !(values[w.id] ?? "").length}
                  className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-slate-800 text-white disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  {busyId === w.id ? "…" : "更新"}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
        <input
          type="text"
          placeholder="銘柄名（例: bitFlyer ETH）"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-48 bg-white"
        />
        <button
          onClick={addWallet}
          disabled={adding || !newName.trim()}
          className="text-xs px-3 py-1.5 rounded-lg font-semibold bg-slate-800 text-white disabled:opacity-40 whitespace-nowrap shrink-0"
        >
          {adding ? "…" : "＋ 銘柄を追加"}
        </button>
      </div>
    </div>
  );
}
