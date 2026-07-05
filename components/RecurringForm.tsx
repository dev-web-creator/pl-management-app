"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InputCategory, WalletOption } from "@/lib/queries";

export type RecurringEdit = {
  id: number;
  name: string;
  amount: number;
  categoryId: number;
  walletId: number;
  startMonth: string; // 'YYYY-MM'
  endMonth: string | null; // 'YYYY-MM' or null
  billingDay: number | null;
  billingCycle: "monthly" | "yearly"; // 月額/年額（ADR-035）
  paymentMonth: number | null; // 年額の支払月
};

export default function RecurringForm({
  categories,
  wallets,
  defaultMonth,
  edit,
}: {
  categories: InputCategory[];
  wallets: WalletOption[];
  defaultMonth: string; // 'YYYY-MM'
  edit?: RecurringEdit;
}) {
  const router = useRouter();
  const isEdit = !!edit;
  const [open, setOpen] = useState(isEdit);
  const [name, setName] = useState(edit?.name ?? "");
  const [amount, setAmount] = useState(edit ? String(edit.amount) : "");
  const [categoryId, setCategoryId] = useState<number>(edit?.categoryId ?? categories[0]?.id ?? 0);
  const [walletId, setWalletId] = useState<number>(edit?.walletId ?? wallets[0]?.id ?? 0);
  const [startMonth, setStartMonth] = useState(edit?.startMonth ?? defaultMonth);
  const [endMonth, setEndMonth] = useState(edit?.endMonth ?? "");
  const [billingDay, setBillingDay] = useState(edit?.billingDay ? String(edit.billingDay) : "");
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">(
    edit?.billingCycle ?? "monthly"
  );
  const [paymentMonth, setPaymentMonth] = useState<number>(edit?.paymentMonth ?? 1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setMsg(null);
    const amt = parseInt(amount, 10);
    if (!name.trim()) return setMsg("名称を入力してください");
    if (isNaN(amt) || amt < 0) return setMsg("金額を入力してください");
    setBusy(true);
    try {
      const url = isEdit ? `/api/recurring/${edit!.id}` : "/api/recurring";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category_id: categoryId,
          amount: amt,
          settlement_wallet_id: walletId,
          start_month: startMonth,
          end_month: endMonth || undefined,
          billing_day: billingDay ? parseInt(billingDay, 10) : undefined,
          billing_cycle: billingCycle,
          payment_month: billingCycle === "yearly" ? paymentMonth : undefined,
        }),
      });
      const d = await res.json();
      if (!d.ok) {
        setMsg("エラー: " + d.error);
      } else {
        router.push("/fixed-costs");
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
        ＋ 固定費を追加
      </button>
    );
  }

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">{isEdit ? `固定費を編集（#${edit!.id}）` : "固定費を追加"}</h2>
        <button
          onClick={() => (isEdit ? router.push("/fixed-costs") : setOpen(false))}
          className="text-slate-400 text-xl leading-none"
        >
          ×
        </button>
      </div>

      <div>
        <label className="text-xs text-slate-500">名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：家賃（SA麻布十番）"
          className="w-full mt-1 border rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {/* 月額/年額の区分（ADR-035）：年額は月次PLに出さず「年額サブスク」として管理 */}
      <div className="flex gap-2 text-sm">
        {(["monthly", "yearly"] as const).map((c) => (
          <button
            key={c}
            onClick={() => setBillingCycle(c)}
            className={
              "flex-1 py-2 rounded-lg font-semibold " +
              (billingCycle === c ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500")
            }
          >
            {c === "monthly" ? "月額" : "年額サブスク"}
          </button>
        ))}
      </div>
      {billingCycle === "yearly" && (
        <p className="text-[11px] text-sky-600 bg-sky-50 rounded p-2">
          年額サブスクは毎月の固定費（予定）には出ません。支払った月に変動費（物品購入費など）で取引入力する現運用のまま、
          ここでは「年間いくら払っているか」の管理台帳として使えます。
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500">
            {billingCycle === "yearly" ? "年額（予定）" : "月額（予定）"}
          </label>
          <input
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="¥0"
            className="w-full mt-1 border rounded-lg px-3 py-2 text-sm tabular-nums"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">カテゴリ（固定費）</label>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(Number(e.target.value))}
            className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500">引落先ウォレット</label>
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
        {billingCycle === "yearly" ? (
          <div>
            <label className="text-xs text-slate-500">支払月</label>
            <select
              value={paymentMonth}
              onChange={(e) => setPaymentMonth(Number(e.target.value))}
              className="w-full mt-1 border rounded-lg px-2 py-2 text-sm"
            >
              {Array.from({ length: 12 }).map((_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}月
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="text-xs text-slate-500">引落日（任意・1〜31）</label>
            <input
              inputMode="numeric"
              value={billingDay}
              onChange={(e) => setBillingDay(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
              placeholder="例：27"
              className="w-full mt-1 border rounded-lg px-3 py-2 text-sm tabular-nums"
            />
          </div>
        )}
        <div>
          <label className="text-xs text-slate-500">開始年月</label>
          <input
            type="month"
            value={startMonth}
            onChange={(e) => setStartMonth(e.target.value)}
            className="w-full mt-1 border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">終了年月（＝解約。空＝継続中）</label>
          <input
            type="month"
            value={endMonth}
            onChange={(e) => setEndMonth(e.target.value)}
            className="w-full mt-1 border rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>
      <p className="text-[11px] text-slate-400">
        終了年月をセットすると、その月から自動で計上対象外になります（履歴は残ります）。解約はこれでOK。
      </p>

      <button
        onClick={submit}
        disabled={busy}
        className="w-full bg-slate-900 text-white font-semibold py-3 rounded-xl disabled:opacity-50"
      >
        {busy ? "保存中..." : isEdit ? "更新する" : "追加する"}
      </button>
      {msg && <p className="text-center text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
