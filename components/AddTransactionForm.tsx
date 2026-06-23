"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InputCategory, WalletOption } from "@/lib/queries";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

const PL_LABEL: Record<string, string> = {
  income: "収入",
  fixed_cost: "固定費",
  variable_cost: "変動費",
  deduction: "控除",
  excluded: "PL対象外",
};

export type EditTarget = {
  id: number;
  type: "expense" | "income";
  amount: number;
  categoryId: number;
  walletId: number;
  date: string;
  memo: string;
  legCount: number;
};

export default function AddTransactionForm({
  categories,
  wallets,
  today,
  edit,
}: {
  categories: InputCategory[];
  wallets: WalletOption[];
  today: string;
  edit?: EditTarget;
}) {
  const router = useRouter();
  const isEdit = !!edit;
  const [open, setOpen] = useState(isEdit);
  const [type, setType] = useState<"expense" | "income">(edit?.type ?? "expense");
  const [amount, setAmount] = useState(edit ? String(edit.amount) : "");
  const [categoryId, setCategoryId] = useState<number>(edit?.categoryId ?? categories[0]?.id ?? 0);
  const [walletId, setWalletId] = useState<number>(edit?.walletId ?? wallets[0]?.id ?? 0);
  const [date, setDate] = useState(edit?.date ?? today);
  const [memo, setMemo] = useState(edit?.memo ?? "");
  // 分割払い（作成時のみ）
  const [split, setSplit] = useState(false);
  const [legs, setLegs] = useState<{ walletId: number; amount: number }[]>([
    { walletId: wallets[0]?.id ?? 0, amount: 0 },
    { walletId: wallets[1]?.id ?? wallets[0]?.id ?? 0, amount: 0 },
  ]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const grouped = categories.reduce<Record<string, InputCategory[]>>((acc, c) => {
    (acc[c.pl_type] ??= []).push(c);
    return acc;
  }, {});

  const useSplit = split && !isEdit;
  const legSum = legs.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const amtNum = parseInt(amount, 10) || 0;

  async function submit() {
    setMsg(null);
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) {
      setMsg("金額を入力してください");
      return;
    }
    let body: Record<string, unknown> = {
      category_id: categoryId,
      type,
      amount: amt,
      accrual_date: date,
      memo: memo || undefined,
    };
    if (useSplit) {
      const valid = legs.filter((l) => (Number(l.amount) || 0) > 0);
      const sum = valid.reduce((s, l) => s + l.amount, 0);
      if (sum !== amt) {
        setMsg(`分割の合計（${yen(sum)}）が金額（${yen(amt)}）と一致しません`);
        return;
      }
      body = { ...body, legs: valid.map((l) => ({ wallet_id: l.walletId, amount: l.amount })) };
    } else {
      body = { ...body, wallet_id: walletId };
    }
    setBusy(true);
    try {
      const url = isEdit ? `/api/transactions/${edit!.id}` : "/api/transactions";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        setMsg("エラー: " + data.error);
      } else if (isEdit) {
        router.push("/transactions");
        router.refresh();
      } else {
        setMsg("✓ 保存しました（#" + data.id + "）");
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
        ＋ 取引を入力
      </button>
    );
  }

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">{isEdit ? `取引を編集（#${edit!.id}）` : "取引を入力"}</h2>
        <button
          onClick={() => (isEdit ? router.push("/transactions") : setOpen(false))}
          className="text-slate-400 text-xl leading-none"
        >
          ×
        </button>
      </div>

      {isEdit && edit!.legCount > 1 && (
        <p className="text-[11px] text-amber-600 bg-amber-50 rounded p-2">
          ⚠️ この取引は分割払い（{edit!.legCount}脚）です。保存すると単一の決済手段に集約されます。
        </p>
      )}

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
        <label className="text-xs text-slate-500">金額（合計）</label>
        <input
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="¥0"
          className="w-full text-2xl font-bold tabular-nums py-2 border-b-2 outline-none focus:border-slate-900"
        />
      </div>

      {!isEdit && (
        <label className="flex items-center gap-2 text-sm text-slate-500">
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
          分割払い（複数の決済手段で支払う／例：カード＋ポイント）
        </label>
      )}

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
        {!useSplit && (
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
        )}
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

      {/* 分割払いの脚エディタ */}
      {useSplit && (
        <div className="space-y-2 bg-slate-50 rounded-xl p-3">
          <div className="text-xs font-semibold text-slate-600">支払いの内訳</div>
          {legs.map((leg, i) => (
            <div key={i} className="flex gap-2">
              <select
                value={leg.walletId}
                onChange={(e) => {
                  const next = legs.slice();
                  next[i] = { ...next[i], walletId: Number(e.target.value) };
                  setLegs(next);
                }}
                className="flex-1 border rounded-lg px-2 py-1.5 text-sm"
              >
                {wallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <input
                inputMode="numeric"
                value={leg.amount === 0 ? "" : String(leg.amount)}
                onChange={(e) => {
                  const next = legs.slice();
                  next[i] = { ...next[i], amount: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 };
                  setLegs(next);
                }}
                placeholder="¥0"
                className="w-24 border rounded-lg px-2 py-1.5 text-sm text-right tabular-nums"
              />
              <button
                onClick={() => setLegs(legs.filter((_, j) => j !== i))}
                className="text-slate-300 hover:text-red-500 px-1"
                aria-label="脚を削除"
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setLegs([...legs, { walletId: wallets[0]?.id ?? 0, amount: 0 }])}
              className="text-xs text-sky-600 hover:underline"
            >
              ＋ 決済手段を追加
            </button>
            <span className={"text-xs tabular-nums " + (legSum === amtNum ? "text-emerald-600" : "text-red-500")}>
              内訳計 {yen(legSum)} / 金額 {yen(amtNum)}
            </span>
          </div>
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy}
        className="w-full bg-slate-900 text-white font-semibold py-3 rounded-xl disabled:opacity-50"
      >
        {busy ? "保存中..." : isEdit ? "更新する" : "保存する"}
      </button>
      {msg && <p className="text-center text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
