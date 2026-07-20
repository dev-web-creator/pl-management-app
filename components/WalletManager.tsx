"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WalletManageRow } from "@/lib/queries";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

const TYPE_LABEL: Record<string, string> = {
  bank: "銀行口座",
  credit_card: "クレジットカード",
  prepaid: "電子マネー・プリペイド",
  points: "ポイント",
  cash: "現金",
  crypto: "暗号資産",
};
const TYPE_EMOJI: Record<string, string> = {
  bank: "🏦",
  credit_card: "💳",
  prepaid: "📱",
  points: "🎫",
  cash: "💵",
  crypto: "₿",
};

type FormState = {
  id?: number;
  name: string;
  type: string;
  initial_balance: string;
  include_in_assets: boolean;
  is_balance_tracked: boolean;
  closing_day: string;
  closing_eom: boolean;
  payment_day: string;
  payment_eom: boolean;
  payment_month_offset: number;
  settlement_wallet_id: number | null;
};

const blank = (): FormState => ({
  name: "",
  type: "bank",
  initial_balance: "",
  include_in_assets: true,
  is_balance_tracked: true,
  closing_day: "",
  closing_eom: false,
  payment_day: "",
  payment_eom: false,
  payment_month_offset: 1,
  settlement_wallet_id: null,
});

const fromRow = (w: WalletManageRow): FormState => ({
  id: w.id,
  name: w.name,
  type: w.type,
  initial_balance: String(w.initial_balance || ""),
  include_in_assets: w.include_in_assets,
  is_balance_tracked: w.is_balance_tracked,
  closing_day: w.closing_day ? String(w.closing_day) : "",
  closing_eom: w.closing_eom,
  payment_day: w.payment_day ? String(w.payment_day) : "",
  payment_eom: w.payment_eom,
  payment_month_offset: w.payment_month_offset,
  settlement_wallet_id: w.settlement_wallet_id,
});

export default function WalletManager({ wallets }: { wallets: WalletManageRow[] }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const banks = wallets.filter((w) => (w.type === "bank" || w.type === "prepaid") && w.is_active);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save() {
    if (!form) return;
    if (!form.name.trim()) return alert("名称を入力してください");
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        type: form.type,
        initial_balance: Number(form.initial_balance) || 0,
        include_in_assets: form.include_in_assets,
        is_balance_tracked: form.is_balance_tracked,
        closing_day: form.closing_day ? Number(form.closing_day) : null,
        closing_eom: form.closing_eom,
        payment_day: form.payment_day ? Number(form.payment_day) : null,
        payment_eom: form.payment_eom,
        payment_month_offset: form.payment_month_offset,
        settlement_wallet_id: form.settlement_wallet_id,
      };
      const res = await fetch(form.id ? `/api/wallets/${form.id}` : "/api/wallets", {
        method: form.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.ok) {
        setForm(null);
        router.refresh();
      } else alert("失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: WalletManageRow) {
    const msg = w.in_use
      ? `「${w.name}」は取引などで使われています。削除ではなく「無効化」します（履歴は残り、選択肢から消えます）。よろしいですか？`
      : `「${w.name}」を削除しますか？`;
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/wallets/${w.id}`, { method: "DELETE" });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  async function reactivate(w: WalletManageRow) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wallets/${w.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fromRow(w), is_active: true, initial_balance: w.initial_balance }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusy(false);
    }
  }

  const isCard = form?.type === "credit_card";

  return (
    <div className="space-y-4">
      {/* 一覧 */}
      <div className="space-y-1.5">
        {wallets.map((w) => (
          <div
            key={w.id}
            className={"flex items-center justify-between gap-2 text-sm py-1.5 " + (w.is_active ? "" : "opacity-40")}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span aria-hidden="true">{TYPE_EMOJI[w.type] ?? "•"}</span>
              <span className="truncate">
                {w.name}
                {!w.is_active && <span className="ml-1 text-[10px] text-red-400">無効</span>}
                <span className="block text-[10px] text-slate-400">
                  {TYPE_LABEL[w.type] ?? w.type}
                  {w.type === "credit_card" &&
                    ` ・ ${w.closing_eom ? "末" : w.closing_day + "日"}締/${w.payment_eom ? "末" : w.payment_day + "日"}払${w.settlement_name ? " → " + w.settlement_name : ""}`}
                </span>
              </span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {w.is_balance_tracked && (
                <span className="tabular-nums text-slate-500 text-xs w-24 text-right">{yen(w.balance)}</span>
              )}
              {w.is_active ? (
                <>
                  <button onClick={() => setForm(fromRow(w))} className="text-[11px] text-sky-600 hover:underline">
                    編集
                  </button>
                  <button onClick={() => remove(w)} disabled={busy} className="text-[11px] text-red-500 hover:underline disabled:opacity-50">
                    {w.in_use ? "無効化" : "削除"}
                  </button>
                </>
              ) : (
                <button onClick={() => reactivate(w)} disabled={busy} className="text-[11px] text-emerald-600 hover:underline disabled:opacity-50">
                  復活
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      {!form && (
        <button
          onClick={() => setForm(blank())}
          className="w-full border-2 border-dashed border-slate-200 rounded-xl py-2.5 text-sm font-semibold text-slate-500 hover:bg-slate-50"
        >
          ＋ 口座・カード・電子マネーを追加
        </button>
      )}

      {/* フォーム */}
      {form && (
        <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/50">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{form.id ? "編集" : "新規追加"}</h3>
            <button onClick={() => setForm(null)} className="text-slate-400 text-lg leading-none">×</button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 text-xs text-slate-500">
              名称
              <input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="例：三井住友銀行 / 楽天カード"
                className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
              />
            </label>
            <label className="text-xs text-slate-500">
              種別
              <select
                value={form.type}
                onChange={(e) => set("type", e.target.value)}
                className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white"
                disabled={!!form.id}
              >
                {Object.entries(TYPE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
            {form.type !== "credit_card" && form.type !== "crypto" && (
              <label className="text-xs text-slate-500">
                開始残高（現在のおおよその残高）
                <input
                  inputMode="numeric"
                  value={form.initial_balance}
                  onChange={(e) => set("initial_balance", e.target.value.replace(/[^0-9-]/g, ""))}
                  placeholder="¥0"
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white tabular-nums"
                />
              </label>
            )}
          </div>

          {isCard && (
            <div className="space-y-2 border-t border-slate-200 pt-3">
              <p className="text-[11px] text-slate-500">
                締め日・支払日を入れると、カードの請求サイクルと引落予定を自動計算します（🔁カード画面）。
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-500">
                  締め日
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      inputMode="numeric"
                      value={form.closing_day}
                      onChange={(e) => set("closing_day", e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                      placeholder="27"
                      disabled={form.closing_eom}
                      className="w-16 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white tabular-nums disabled:opacity-40"
                    />
                    <label className="flex items-center gap-1 text-[11px]">
                      <input type="checkbox" checked={form.closing_eom} onChange={(e) => set("closing_eom", e.target.checked)} />
                      末締め
                    </label>
                  </div>
                </label>
                <label className="text-xs text-slate-500">
                  支払日
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      inputMode="numeric"
                      value={form.payment_day}
                      onChange={(e) => set("payment_day", e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                      placeholder="27"
                      disabled={form.payment_eom}
                      className="w-16 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white tabular-nums disabled:opacity-40"
                    />
                    <label className="flex items-center gap-1 text-[11px]">
                      <input type="checkbox" checked={form.payment_eom} onChange={(e) => set("payment_eom", e.target.checked)} />
                      末払い
                    </label>
                  </div>
                </label>
                <label className="text-xs text-slate-500">
                  支払いは締めの
                  <select
                    value={form.payment_month_offset}
                    onChange={(e) => set("payment_month_offset", Number(e.target.value))}
                    className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white"
                  >
                    <option value={0}>当月</option>
                    <option value={1}>翌月</option>
                    <option value={2}>翌々月</option>
                  </select>
                </label>
                <label className="text-xs text-slate-500">
                  引落先口座
                  <select
                    value={form.settlement_wallet_id ?? ""}
                    onChange={(e) => set("settlement_wallet_id", e.target.value ? Number(e.target.value) : null)}
                    className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white"
                  >
                    <option value="">（未設定）</option>
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          )}

          <button
            onClick={save}
            disabled={busy}
            className="w-full bg-slate-800 text-white font-semibold py-2.5 rounded-xl text-sm disabled:opacity-40"
          >
            {busy ? "保存中…" : form.id ? "更新する" : "追加する"}
          </button>
        </div>
      )}
    </div>
  );
}
