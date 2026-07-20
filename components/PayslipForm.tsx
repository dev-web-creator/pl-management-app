"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PayslipEdit, PayslipItemRow } from "@/lib/queries";

const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

// 新規時の既定項目（master-data 由来）
const DEFAULT_ALLOWANCES = [
  "月給",
  "固定時間外手当(30h固定)",
  "固定時間外手当(30h超過)",
  "時間外労働手当(60h超過)",
  "深夜労働手当",
  "勤怠控除",
  "非課税通勤手当",
  "課税通勤手当",
];
const DEFAULT_DEDUCTIONS = [
  "健康保険料",
  "厚生年金保険料",
  "雇用保険料",
  "所得税",
  "住民税",
  "子ども・子育て支援金",
];

const seed = (names: string[]): PayslipItemRow[] => names.map((name) => ({ name, amount: 0 }));

export default function PayslipForm({
  initial,
  ocrEnabled,
}: {
  initial: PayslipEdit;
  ocrEnabled?: boolean; // GEMINI_API_KEY 設定時のみ true（ADR-039）
}) {
  const router = useRouter();
  const [workHours, setWorkHours] = useState(initial.total_work_hours);
  const [overtime, setOvertime] = useState(initial.overtime_hours);
  const [confirmed, setConfirmed] = useState(initial.is_confirmed);
  const [allowances, setAllowances] = useState<PayslipItemRow[]>(
    initial.allowances.length ? initial.allowances : seed(DEFAULT_ALLOWANCES)
  );
  const [deductions, setDeductions] = useState<PayslipItemRow[]>(
    initial.deductions.length ? initial.deductions : seed(DEFAULT_DEDUCTIONS)
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);

  // 画像を縮小してbase64化（スマホ写真をそのまま送るとデカすぎるため最大1600pxのJPEGに）
  async function toResizedBase64(file: File): Promise<{ data: string; mime: string }> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { data: dataUrl.split(",")[1], mime: "image/jpeg" };
  }

  // PDF/画像 → 送信ペイロード。PDFは縮小できないためサイズ上限あり
  // （Vercelのリクエスト上限4.5MB・base64で約1.33倍に膨らむことを考慮して3MBまで）
  async function toPayload(file: File): Promise<{ data: string; mime: string }> {
    if (file.type === "application/pdf") {
      if (file.size > 3 * 1024 * 1024) {
        throw new Error("PDFが大きすぎます（3MBまで）。該当ページだけのPDFにするか、スクショ画像でお試しください");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { data: btoa(bin), mime: "application/pdf" };
    }
    return toResizedBase64(file);
  }

  async function runOcr(file: File) {
    setMsg(null);
    setOcrBusy(true);
    try {
      const { data, mime } = await toPayload(file);
      const res = await fetch("/api/payslips/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: data, mime_type: mime }),
      });
      const d = await res.json();
      if (!d.ok) {
        setMsg("読み取り失敗: " + d.error);
        return;
      }
      // 読み取れた分だけ反映（空配列なら既存を保持）
      if (d.data.allowances.length) setAllowances(d.data.allowances);
      if (d.data.deductions.length) setDeductions(d.data.deductions);
      if (d.data.total_work_hours != null) setWorkHours(String(d.data.total_work_hours));
      if (d.data.overtime_hours != null) setOvertime(String(d.data.overtime_hours));
      setMsg(
        `📷 読み取り完了：支給${d.data.allowances.length}項目・控除${d.data.deductions.length}項目。` +
          "内容を確認・修正してから保存してください"
      );
    } catch (e) {
      setMsg("読み取りエラー: " + (e instanceof Error ? e.message : ""));
    } finally {
      setOcrBusy(false);
    }
  }

  const gross = allowances.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const dedTotal = deductions.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const net = gross - dedTotal;
  const wh = parseFloat(workHours);
  const hourly = wh > 0 ? Math.round(gross / wh) : null;

  function updateRow(
    list: PayslipItemRow[],
    setList: (v: PayslipItemRow[]) => void,
    idx: number,
    field: "name" | "amount",
    value: string
  ) {
    const next = list.slice();
    next[idx] = { ...next[idx], [field]: field === "amount" ? Number(value.replace(/[^0-9-]/g, "")) || 0 : value };
    setList(next);
  }

  async function submit() {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/payslips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: initial.period,
          total_work_hours: workHours || null,
          overtime_hours: overtime || null,
          is_confirmed: confirmed,
          allowances,
          deductions,
        }),
      });
      const d = await res.json();
      if (!d.ok) setMsg("エラー: " + d.error);
      else {
        router.push("/payslips");
        router.refresh();
      }
    } catch (e) {
      setMsg("通信エラー: " + (e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }

  const Section = ({
    title,
    list,
    setList,
  }: {
    title: string;
    list: PayslipItemRow[];
    setList: (v: PayslipItemRow[]) => void;
  }) => (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-600">{title}</h3>
      {list.map((row, i) => (
        <div key={i} className="flex gap-2">
          <input
            value={row.name}
            onChange={(e) => updateRow(list, setList, i, "name", e.target.value)}
            placeholder="項目名"
            className="flex-1 border rounded-lg px-2 py-1.5 text-sm"
          />
          <input
            inputMode="numeric"
            value={row.amount === 0 ? "" : String(row.amount)}
            onChange={(e) => updateRow(list, setList, i, "amount", e.target.value)}
            placeholder="¥0"
            className="w-28 border rounded-lg px-2 py-1.5 text-sm text-right tabular-nums"
          />
          <button
            onClick={() => setList(list.filter((_, j) => j !== i))}
            className="text-slate-300 hover:text-red-500 px-1"
            aria-label="行を削除"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() => setList([...list, { name: "", amount: 0 }])}
        className="text-xs text-sky-600 hover:underline"
      >
        ＋ 行を追加
      </button>
    </div>
  );

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
      {/* OCR自動入力（GEMINI_API_KEY設定時のみ表示 / ADR-039） */}
      {ocrEnabled && (
        <label
          className={
            "flex items-center justify-center gap-2 border-2 border-dashed border-emerald-300 bg-emerald-50/50 rounded-xl py-3 text-sm font-semibold text-emerald-700 cursor-pointer hover:bg-emerald-50 " +
            (ocrBusy ? "opacity-60 pointer-events-none" : "")
          }
        >
          {ocrBusy ? "🔍 読み取り中…（10秒ほど）" : "📷 給与明細の画像・PDFから自動入力"}
          <input
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            disabled={ocrBusy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) runOcr(f);
              e.target.value = "";
            }}
          />
        </label>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500">総労働時間（h）</label>
          <input
            inputMode="decimal"
            value={workHours}
            onChange={(e) => setWorkHours(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="例：160"
            className="w-full mt-1 border rounded-lg px-3 py-2 text-sm tabular-nums"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">時間外労働時間（h）</label>
          <input
            inputMode="decimal"
            value={overtime}
            onChange={(e) => setOvertime(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="例：20"
            className="w-full mt-1 border rounded-lg px-3 py-2 text-sm tabular-nums"
          />
        </div>
      </div>

      <Section title="支給" list={allowances} setList={setAllowances} />
      <Section title="控除" list={deductions} setList={setDeductions} />

      {/* 計算結果 */}
      <div className="bg-slate-50 rounded-xl p-3 space-y-1 text-sm">
        <div className="flex justify-between"><span className="text-slate-500">総支給額</span><span className="tabular-nums font-semibold">{yen(gross)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">− 控除合計</span><span className="tabular-nums text-slate-500">{yen(dedTotal)}</span></div>
        <div className="flex justify-between border-t pt-1"><span className="font-bold">手取り</span><span className="tabular-nums font-extrabold text-emerald-600">{yen(net)}</span></div>
        {hourly != null && (
          <div className="flex justify-between text-xs text-slate-400"><span>時給換算（総支給÷総労働時間）</span><span className="tabular-nums">{yen(hourly)} / h</span></div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-500">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> 確定（確定/予定）
      </label>

      <button onClick={submit} disabled={busy} className="w-full bg-slate-900 text-white font-semibold py-3 rounded-xl disabled:opacity-50">
        {busy ? "保存中..." : "保存する"}
      </button>
      {msg && <p className="text-center text-sm text-slate-600">{msg}</p>}
      <p className="text-[11px] text-slate-400 text-center">
        ※ 税金・社会保険料はここ（控除）で管理し、支出には計上しません（手取りに織り込み済み・ADR-022）。
      </p>
    </section>
  );
}
