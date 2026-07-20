import { NextResponse } from "next/server";
import pool, { ensureMigrated } from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

export const WALLET_TYPES = ["bank", "credit_card", "prepaid", "points", "cash", "crypto"] as const;
type WalletType = (typeof WALLET_TYPES)[number];

export type WalletBody = {
  name?: string;
  type?: string;
  initial_balance?: number;
  include_in_assets?: boolean;
  is_balance_tracked?: boolean;
  // カード専用
  closing_day?: number | null;
  closing_eom?: boolean;
  payment_day?: number | null;
  payment_eom?: boolean;
  payment_month_offset?: number;
  settlement_wallet_id?: number | null;
};

// body を検証し、INSERT/UPDATE 用の正規化済みフィールドを返す（不正なら {error}）
export async function normalizeWallet(
  b: WalletBody,
  userId: number
): Promise<{ error: string } | { fields: Record<string, unknown> }> {
  const name = (b.name ?? "").trim().slice(0, 50);
  if (!name) return { error: "名称は必須です" };
  if (!WALLET_TYPES.includes(b.type as WalletType)) {
    return { error: `種別は ${WALLET_TYPES.join(" / ")} のいずれかです` };
  }
  const type = b.type as WalletType;

  const day = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 31 ? n : NaN as unknown as number;
  };

  const fields: Record<string, unknown> = {
    name,
    type,
    initial_balance: Math.round(Number(b.initial_balance) || 0),
    include_in_assets: b.include_in_assets ?? (type !== "credit_card"),
    is_balance_tracked: b.is_balance_tracked ?? (type !== "cash"),
    closing_day: null,
    closing_eom: false,
    payment_day: null,
    payment_eom: false,
    payment_month_offset: 1,
    settlement_wallet_id: null,
  };

  if (type === "credit_card") {
    const cd = day(b.closing_day);
    const pd = day(b.payment_day);
    if (Number.isNaN(cd) || Number.isNaN(pd)) {
      return { error: "締め日・支払日は1〜31で入力してください" };
    }
    const closingEom = !!b.closing_eom;
    const paymentEom = !!b.payment_eom;
    if (!closingEom && cd === null) return { error: "カードは締め日（または末締め）が必要です" };
    if (!paymentEom && pd === null) return { error: "カードは支払日（または末払い）が必要です" };
    fields.closing_day = closingEom ? null : cd;
    fields.closing_eom = closingEom;
    fields.payment_day = paymentEom ? null : pd;
    fields.payment_eom = paymentEom;
    const off = Number(b.payment_month_offset);
    fields.payment_month_offset = Number.isInteger(off) && off >= 0 && off <= 3 ? off : 1;
    // 引落先は自分の銀行/プリペイド口座のみ許可
    if (b.settlement_wallet_id != null) {
      const sw = await pool.query(
        `SELECT 1 FROM wallets WHERE id=$1 AND user_id=$2 AND type IN ('bank','prepaid')`,
        [b.settlement_wallet_id, userId]
      );
      if (sw.rowCount === 0) return { error: "引落先は自分の銀行/プリペイド口座を選んでください" };
      fields.settlement_wallet_id = b.settlement_wallet_id;
    }
    fields.include_in_assets = false; // カードは残高がマイナス（未払い）なので資産合計には入れない
  }
  return { fields };
}

// ウォレット追加（全種別対応 / ADR-048。旧: crypto専用だったのを一般化）
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  await ensureMigrated();

  let b: WalletBody;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  const norm = await normalizeWallet(b, USER_ID);
  if ("error" in norm) return NextResponse.json({ ok: false, error: norm.error }, { status: 400 });
  const f = norm.fields;

  try {
    const r = await pool.query(
      `INSERT INTO wallets
         (user_id, name, type, initial_balance, include_in_assets, is_balance_tracked,
          closing_day, closing_eom, payment_day, payment_eom, payment_month_offset, settlement_wallet_id, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          COALESCE((SELECT MAX(display_order)+1 FROM wallets WHERE user_id=$1), 1))
       RETURNING id`,
      [USER_ID, f.name, f.type, f.initial_balance, f.include_in_assets, f.is_balance_tracked,
       f.closing_day, f.closing_eom, f.payment_day, f.payment_eom, f.payment_month_offset, f.settlement_wallet_id]
    );
    return NextResponse.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "不明なエラー" },
      { status: 500 }
    );
  }
}
