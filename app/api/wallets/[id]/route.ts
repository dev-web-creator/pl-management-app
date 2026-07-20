import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";
import { normalizeWallet, type WalletBody } from "../route";

// ウォレット更新（ADR-048）
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const wid = Number(id);
  if (!Number.isInteger(wid) || wid <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  let b: WalletBody & { is_active?: boolean };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  // 引落先の自己参照ループを防ぐ
  if (b.settlement_wallet_id === wid) {
    return NextResponse.json({ ok: false, error: "引落先に自分自身は指定できません" }, { status: 400 });
  }
  const norm = await normalizeWallet(b, USER_ID);
  if ("error" in norm) return NextResponse.json({ ok: false, error: norm.error }, { status: 400 });
  const f = norm.fields;

  const r = await pool.query(
    `UPDATE wallets SET
       name=$1, type=$2, initial_balance=$3, include_in_assets=$4, is_balance_tracked=$5,
       closing_day=$6, closing_eom=$7, payment_day=$8, payment_eom=$9,
       payment_month_offset=$10, settlement_wallet_id=$11,
       is_active=COALESCE($12, is_active)
     WHERE id=$13 AND user_id=$14`,
    [f.name, f.type, f.initial_balance, f.include_in_assets, f.is_balance_tracked,
     f.closing_day, f.closing_eom, f.payment_day, f.payment_eom, f.payment_month_offset,
     f.settlement_wallet_id, typeof b.is_active === "boolean" ? b.is_active : null, wid, USER_ID]
  );
  if (r.rowCount === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

// ウォレット削除（ADR-048）。取引・振替・固定費・カード明細から参照されていれば
// 物理削除せず「無効化（is_active=false）」して履歴を守る。未使用なら物理削除。
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const wid = Number(id);
  if (!Number.isInteger(wid) || wid <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  const owned = await pool.query(`SELECT 1 FROM wallets WHERE id=$1 AND user_id=$2`, [wid, USER_ID]);
  if (owned.rowCount === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  const refs = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM transaction_legs WHERE wallet_id=$1)
       + (SELECT COUNT(*) FROM transfers WHERE from_wallet_id=$1 OR to_wallet_id=$1)
       + (SELECT COUNT(*) FROM recurring_rules WHERE settlement_wallet_id=$1)
       + (SELECT COUNT(*) FROM card_statements WHERE wallet_id=$1)
       + (SELECT COUNT(*) FROM wallets WHERE settlement_wallet_id=$1) AS cnt`,
    [wid]
  );
  const used = Number(refs.rows[0].cnt) > 0;

  if (used) {
    await pool.query(`UPDATE wallets SET is_active=false WHERE id=$1 AND user_id=$2`, [wid, USER_ID]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await pool.query(`DELETE FROM wallets WHERE id=$1 AND user_id=$2`, [wid, USER_ID]);
  return NextResponse.json({ ok: true, deleted: true });
}
