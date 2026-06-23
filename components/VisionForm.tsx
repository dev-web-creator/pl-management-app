"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function VisionForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [content, setContent] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const d = await res.json();
      if (!d.ok) setMsg("エラー: " + d.error);
      else {
        setMsg("✓ 保存しました");
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
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={14}
        placeholder={"例：\n・30歳までに純資産1,000万円\n・2026年やりたいこと：旅行2回 / 読書50冊\n・美容に年120万まで\n・副業を月10万に\n自由に書いてOK（ここはメモ帳です）"}
        className="w-full border rounded-xl px-3 py-2 text-sm leading-relaxed outline-none focus:border-slate-900"
      />
      <button
        onClick={save}
        disabled={busy}
        className="w-full bg-slate-900 text-white font-semibold py-2.5 rounded-xl disabled:opacity-50"
      >
        {busy ? "保存中..." : "保存する"}
      </button>
      {msg && <p className="text-center text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
