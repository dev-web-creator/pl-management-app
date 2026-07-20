"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CategoryManageRow } from "@/lib/queries";

const PL_META: { key: string; label: string; emoji: string; hint: string }[] = [
  { key: "income", label: "収入", emoji: "💰", hint: "給与・副業・家族収入・ポイント収入など" },
  { key: "fixed_cost", label: "固定費", emoji: "📌", hint: "家賃・保険・サブスクなど毎月ほぼ固定の支出" },
  { key: "variable_cost", label: "変動費", emoji: "🛒", hint: "食費・交際費・趣味など月で変わる支出。グループにまとめられます" },
  { key: "deduction", label: "控除（給与明細用）", emoji: "🧾", hint: "所得税・社会保険料など。手取りの計算に使います" },
  { key: "excluded", label: "PL対象外", emoji: "↔️", hint: "経費立替・借入金など損益に含めない出入り" },
];

export default function CategoryManager({ categories }: { categories: CategoryManageRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [addFor, setAddFor] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState<number | null>(null);

  async function rename(id: number) {
    if (!editName.trim()) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      const d = await res.json();
      if (d.ok) {
        setEditingId(null);
        router.refresh();
      } else alert("失敗: " + d.error);
    } finally {
      setBusy(null);
    }
  }

  async function setActive(c: CategoryManageRow, active: boolean) {
    setBusy(c.id);
    try {
      const res = await fetch(`/api/categories/${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: active }),
      });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert("失敗: " + d.error);
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: CategoryManageRow) {
    if (!confirm(`「${c.name}」を削除しますか？`)) return;
    setBusy(c.id);
    try {
      const res = await fetch(`/api/categories/${c.id}`, { method: "DELETE" });
      const d = await res.json();
      if (d.ok) router.refresh();
      else alert(d.error);
    } finally {
      setBusy(null);
    }
  }

  async function add(plType: string) {
    if (!newName.trim()) return;
    setBusy("new");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), pl_type: plType, parent_id: newParent }),
      });
      const d = await res.json();
      if (d.ok) {
        setNewName("");
        setNewParent(null);
        setAddFor(null);
        router.refresh();
      } else alert("失敗: " + d.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {PL_META.map((pl) => {
        const items = categories.filter((c) => c.pl_type === pl.key);
        // 親→子→孫…の順に深さ付きで並べる（任意の階層に対応）
        const ordered: { c: CategoryManageRow; depth: number }[] = [];
        const walk = (parentId: number | null, depth: number) => {
          for (const c of items.filter((x) => x.parent_id === parentId)) {
            ordered.push({ c, depth });
            walk(c.id, depth + 1);
          }
        };
        walk(null, 0);
        // 親（グループ化先）候補：このpl_typeのアクティブな費目すべて
        const parentOptions = items.filter((c) => c.is_active);

        return (
          <section key={pl.key}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-slate-600">
                {pl.emoji} {pl.label}
              </h3>
              <button
                onClick={() => {
                  setAddFor(addFor === pl.key ? null : pl.key);
                  setNewName("");
                  setNewParent(null);
                }}
                className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
              >
                ＋費目を追加
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mb-2">{pl.hint}</p>

            {addFor === pl.key && (
              <div className="flex flex-wrap items-center gap-2 mb-2 p-2 rounded-lg bg-slate-50 border border-slate-100">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="費目名（例：カフェ代）"
                  className="border border-slate-200 rounded px-2 py-1 text-sm bg-white flex-1 min-w-32"
                />
                {parentOptions.length > 0 && (
                  <select
                    value={newParent ?? ""}
                    onChange={(e) => setNewParent(e.target.value ? Number(e.target.value) : null)}
                    className="border border-slate-200 rounded px-2 py-1 text-xs bg-white"
                  >
                    <option value="">親なし（単独）</option>
                    {parentOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} の中に入れる
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => add(pl.key)}
                  disabled={busy === "new" || !newName.trim()}
                  className="text-xs px-3 py-1 rounded bg-slate-800 text-white disabled:opacity-40"
                >
                  追加
                </button>
              </div>
            )}

            <div className="space-y-0.5">
              {ordered.length === 0 ? (
                <p className="text-xs text-slate-400">まだありません。</p>
              ) : null}
              {ordered.map(({ c, depth }) => {
                const isGroup = c.child_count > 0;
                return (
                  <div
                    key={`cat-${c.id}`}
                    style={{ paddingLeft: depth * 20 }}
                    className={"flex items-center justify-between gap-2 text-sm py-1 " + (c.is_active ? "" : "opacity-40")}
                  >
                    {editingId === c.id ? (
                      <span className="flex items-center gap-1 flex-1">
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="border border-slate-200 rounded px-2 py-0.5 text-sm bg-white flex-1 min-w-0"
                        />
                        <button onClick={() => rename(c.id)} disabled={busy === c.id} className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-white">保存</button>
                        <button onClick={() => setEditingId(null)} className="text-[11px] text-slate-400 px-1">×</button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span className="truncate">{depth > 0 ? "└ " : ""}{c.name}</span>
                        {isGroup && <span className="text-[9px] px-1 rounded bg-slate-100 text-slate-400 shrink-0">グループ</span>}
                        {c.tx_count > 0 && <span className="text-[9px] text-slate-300 shrink-0">{c.tx_count}件</span>}
                        {!c.is_active && <span className="text-[9px] text-red-400 shrink-0">無効</span>}
                      </span>
                    )}
                    {editingId !== c.id && (
                      <span className="flex items-center gap-2 shrink-0">
                        {c.is_active ? (
                          <>
                            <button onClick={() => { setEditingId(c.id); setEditName(c.name); }} className="text-[11px] text-sky-600 hover:underline">名前</button>
                            {c.tx_count === 0 && c.child_count === 0 ? (
                              <button onClick={() => remove(c)} disabled={busy === c.id} className="text-[11px] text-red-500 hover:underline disabled:opacity-50">削除</button>
                            ) : (
                              <button onClick={() => setActive(c, false)} disabled={busy === c.id} className="text-[11px] text-red-500 hover:underline disabled:opacity-50">無効化</button>
                            )}
                          </>
                        ) : (
                          <button onClick={() => setActive(c, true)} disabled={busy === c.id} className="text-[11px] text-emerald-600 hover:underline disabled:opacity-50">復活</button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
