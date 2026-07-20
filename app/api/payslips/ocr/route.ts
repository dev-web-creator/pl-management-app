import { NextResponse } from "next/server";
import { requireAuthApi } from "@/lib/auth";

// 給与明細OCR（ADR-039）：Gemini に明細画像を渡し、支給/控除の内訳をJSONで抽出する。
// GEMINI_API_KEY（Google AI Studio の無料キー）が未設定の間、この機能は無効。
// 画像はDBに保存しない（読み取り結果だけをフォームに流し込む使い捨て）。

// env は貼り付け時の前後空白・改行に耐えるよう trim する（空白入りモデル名はGeminiが404を返す）
const MODEL = (process.env.GEMINI_MODEL || "").trim() || "gemini-2.5-flash";
// 既定モデルが404（このキー/APIバージョンで利用不可）のとき、ListModelsから自動解決した結果。
// サーバーレスのコールドスタートまで保持され、以降のリクエストは解決済みモデルを直接使う。
let resolvedModel: string | null = null;

// キーで利用できる Gemini の flash 系モデルを新しい順に探す（404時のフォールバック）
async function pickAvailableModel(key: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`
    );
    if (!res.ok) return null;
    const d = await res.json();
    const names: string[] = (Array.isArray(d.models) ? d.models : [])
      .filter((m: { supportedGenerationMethods?: string[] }) =>
        m.supportedGenerationMethods?.includes("generateContent")
      )
      .map((m: { name?: string }) => String(m.name ?? "").replace(/^models\//, ""))
      .filter(
        (n: string) =>
          n.startsWith("gemini") &&
          n.includes("flash") &&
          !/live|tts|image|audio|embedding|thinking/.test(n)
      );
    if (names.length === 0) return null;
    names.sort().reverse(); // 名前の降順 ≒ 新しいバージョンが先頭
    return names.find((n) => !/preview|exp/.test(n)) ?? names[0];
  } catch {
    return null;
  }
}

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const PROMPT = `これは日本の給与明細（画像またはPDF）です。記載されている内容を読み取り、次のJSONだけを出力してください。
{
  "period": "YYYY-MM（支給対象の年月。読み取れなければnull）",
  "total_work_hours": 総労働時間の数値（記載が無ければnull）,
  "overtime_hours": 時間外労働時間の数値（記載が無ければnull）,
  "allowances": [{"name": "支給項目名", "amount": 金額の整数}],
  "deductions": [{"name": "控除項目名", "amount": 金額の整数}]
}
ルール:
- allowances は「支給」欄の項目（基本給・各種手当・通勤手当など）。合計行（総支給額など）は含めない。
- deductions は「控除」欄の項目（健康保険料・厚生年金保険料・雇用保険料・所得税・住民税など）。合計行は含めない。
- 金額はカンマや円記号を除いた整数。マイナス表記はマイナスの整数に。
- 項目名は明細の表記のまま。読み取れない項目は入れない。`;

export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;

  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "GEMINI_API_KEY が未設定です（Google AI Studio で無料発行できます）" },
      { status: 400 }
    );
  }

  let body: { image?: string; mime_type?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  if (!body.image || !body.mime_type) {
    return NextResponse.json({ ok: false, error: "image / mime_type は必須です" }, { status: 400 });
  }
  if (!ALLOWED_MIME.includes(body.mime_type)) {
    return NextResponse.json(
      { ok: false, error: "対応形式は JPEG / PNG / WebP / PDF です" },
      { status: 400 }
    );
  }

  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: body.mime_type, data: body.image } },
        ],
      },
    ],
    generationConfig: { response_mime_type: "application/json", temperature: 0 },
  });
  const call = (model: string) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

  let model = resolvedModel ?? MODEL;
  let res = await call(model);

  // 404 = このキー/APIバージョンでそのモデル名が使えない → 利用可能なモデルを自動解決して1回だけ再試行
  if (res.status === 404 && !resolvedModel) {
    const alt = await pickAvailableModel(key);
    if (alt && alt !== model) {
      console.warn(`Gemini model "${model}" not found. Falling back to "${alt}"`);
      model = alt;
      res = await call(model);
      if (res.ok) resolvedModel = alt;
    }
  }

  if (!res.ok) {
    const detail = await res.text();
    console.error("Gemini API error:", res.status, detail.slice(0, 500));
    const hint =
      res.status === 404
        ? `モデル「${model}」がこのAPIキーで利用できません。Vercelの環境変数 GEMINI_MODEL に利用可能なモデル名を設定してください`
        : res.status === 429
        ? "無料枠のレート制限に達しました。1分ほど待って再試行してください"
        : "時間をおいて再試行してください";
    return NextResponse.json(
      { ok: false, error: `読み取りAPIがエラーを返しました（${res.status}）。${hint}` },
      { status: 502 }
    );
  }

  try {
    const d = await res.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text);
    // 最低限の形の検証と正規化
    const norm = (rows: unknown): { name: string; amount: number }[] =>
      Array.isArray(rows)
        ? rows
            .filter((r) => r && typeof r === "object" && (r as { name?: unknown }).name)
            .map((r) => ({
              name: String((r as { name: unknown }).name),
              amount: Math.trunc(Number((r as { amount?: unknown }).amount)) || 0,
            }))
        : [];
    return NextResponse.json({
      ok: true,
      data: {
        period: typeof parsed.period === "string" ? parsed.period.slice(0, 7) : null,
        total_work_hours: parsed.total_work_hours != null ? Number(parsed.total_work_hours) : null,
        overtime_hours: parsed.overtime_hours != null ? Number(parsed.overtime_hours) : null,
        allowances: norm(parsed.allowances),
        deductions: norm(parsed.deductions),
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "読み取り結果の解析に失敗しました。画像を明るく・正面から撮り直してみてください" },
      { status: 502 }
    );
  }
}
