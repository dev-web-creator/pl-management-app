"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WalletOption } from "@/lib/queries";

const KINDS: { value: string; label: string }[] = [
  { value: "transfer", label: "振替（口座間）" },
  { value: "charge", label: "チャージ（→プリペイド）" },
  { value: "card_settlement", label: "カード支払い（銀行→カード）" },
  { value: "cash_withdrawal", label: "現金引き出し" },
];

export default function AddTransferForm({
  wallets,
  today,
}: {
  wallets: WalletOption[];
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("transfer");
  const [fromId, setFromId] = useState<number>(wallets[0]?.id ?? 0);
  const [toId, setToId] = useState<number>(wallets[1]?.id ?? 0);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setMsg(null);
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) return setMsg("金額を入力してください");
    if (fromId === toId) return setMsg("出金元と入金先が同じです");
    setBusy(true);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_wallet_id: fromId,
          to_wallet_id: toId,
          amount: amt,
          kind,
          transfer_date: date,
          memo: memo || undefined,
        }),
      });
      const d = await res.json();
      if (!d.ok) setMsg("エラー: " + d.error);
      else {
        setMsg("✓ 記録しました（#" + d.id + "）");
        setAmount("");
        setMemo("");
        router.refresh();
      }
    } catch (e) {
      setMsg("通信エラー: " + (e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full bg-slate-900 text-white rounded-2xl py-3 font-semibold shadow-sm hover:bg-slate-700"
      >
        ＋ 資金移動を入力
      </button>
    );
  }

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">資金移動を入力</h2>
        <button onClick={() => setOpen(false)} className="text-slate-400 text-xl leading-none">
          ×
        </button>
      </div>

      <div>
        <label className="text-xs text-slate-500">種類</label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-xs text-slate-500">金額</label>
        <input
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="¥0"
          className="w-full text-2xl font-bold tabular-nums py-2 border-b-2 outline-none focus:border-slate-900"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500">出金元（from）</label>
          <select
            value={fromId}
            onChange={(e) => setFromId(Number(e.target.value))}
            className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500">入金先（to）</label>
          <select
            value={toId}
            onChange={(e) => setToId(Number(e.target.value))}
            className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500">日付</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">メモ</label>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="任意"
            className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
          />
        </div>
      </div>

      <p className="text-[11px] text-slate-400">
        資金移動はPL（損益）には計上されません。出金元の残高が減り、入金先の残高が増えます（カード支払いはカード未払いが減ります）。
      </p>

      <button
        onClick={submit}
        disabled={busy}
        className="w-full bg-slate-900 text-white font-semibold py-3 rounded-xl disabled:opacity-50"
      >
        {busy ? "保存中..." : "保存する"}
      </button>
      {msg && <p className="text-center text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
