"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InputCategory, WalletOption } from "@/lib/queries";

const PL_LABEL: Record<string, string> = {
  income: "収入",
  fixed_cost: "固定費",
  variable_cost: "変動費",
  deduction: "控除",
  excluded: "PL対象外",
};

export default function AddTransactionForm({
  categories,
  wallets,
  today,
}: {
  categories: InputCategory[];
  wallets: WalletOption[];
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<number>(categories[0]?.id ?? 0);
  const [walletId, setWalletId] = useState<number>(wallets[0]?.id ?? 0);
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // PL区分ごとにカテゴリをグループ化
  const grouped = categories.reduce<Record<string, InputCategory[]>>((acc, c) => {
    (acc[c.pl_type] ??= []).push(c);
    return acc;
  }, {});

  async function submit() {
    setMsg(null);
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) {
      setMsg("金額を入力してください");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category_id: categoryId,
          type,
          amount: amt,
          accrual_date: date,
          memo: memo || undefined,
          wallet_id: walletId,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setMsg("エラー: " + data.error);
      } else {
        setMsg("✓ 保存しました（#" + data.id + "）");
        setAmount("");
        setMemo("");
        router.refresh(); // サーバーコンポーネントを再取得＝全数字が即更新
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
        ＋ 取引を入力
      </button>
    );
  }

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">取引を入力</h2>
        <button onClick={() => setOpen(false)} className="text-slate-400 text-xl leading-none">
          ×
        </button>
      </div>

      <div className="flex gap-2 text-sm">
        {(["expense", "income"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={
              "flex-1 py-2 rounded-lg font-semibold " +
              (type === t ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500")
            }
          >
            {t === "expense" ? "支出" : "収入"}
          </button>
        ))}
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
          <label className="text-xs text-slate-500">カテゴリ</label>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(Number(e.target.value))}
            className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
          >
            {Object.entries(grouped).map(([pl, cats]) => (
              <optgroup key={pl} label={PL_LABEL[pl] ?? pl}>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500">決済手段</label>
          <select
            value={walletId}
            onChange={(e) => setWalletId(Number(e.target.value))}
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
          <label className="text-xs text-slate-500">発生日</label>
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
