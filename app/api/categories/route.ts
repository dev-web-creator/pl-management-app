import { NextResponse } from "next/server";
import pool, { ensureMigrated } from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

export const PL_TYPES = ["income", "fixed_cost", "variable_cost", "deduction", "excluded"] as const;
type PlType = (typeof PL_TYPES)[number];

// 費目（カテゴリ）を追加（ADR-050）。
// parent_id 指定時は同じ pl_type の入力可グループ配下の葉として作る。
export async function POST(req: Request) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  await ensureMigrated();

  let b: { name?: string; pl_type?: string; parent_id?: number | null };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }
  const name = (b.name ?? "").trim().slice(0, 40);
  if (!name) return NextResponse.json({ ok: false, error: "費目名は必須です" }, { status: 400 });
  if (!PL_TYPES.includes(b.pl_type as PlType)) {
    return NextResponse.json({ ok: false, error: "PL区分が不正です" }, { status: 400 });
  }
  const plType = b.pl_type as PlType;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 親の検証（自分の同一pl_type）＋親を集計ノード化（is_input_allowed=false）
    let parentId: number | null = null;
    if (b.parent_id != null) {
      const p = await client.query(
        `SELECT id FROM categories WHERE id=$1 AND user_id=$2 AND pl_type=$3 FOR UPDATE`,
        [b.parent_id, USER_ID, plType]
      );
      if (p.rowCount === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ ok: false, error: "親カテゴリが不正です（同じPL区分の費目を選んでください）" }, { status: 400 });
      }
      parentId = b.parent_id;
      // 親は集計ノードにする（取引は葉のみ・ADR-008）
      await client.query(`UPDATE categories SET is_input_allowed=false WHERE id=$1`, [parentId]);
    }
    // 重複名チェック（同一ユーザー・同一pl_type・アクティブ）
    const dup = await client.query(
      `SELECT 1 FROM categories WHERE user_id=$1 AND pl_type=$2 AND name=$3 AND is_active`,
      [USER_ID, plType, name]
    );
    if (dup.rowCount && dup.rowCount > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ ok: false, error: "同じ名前の費目が既にあります" }, { status: 409 });
    }
    const r = await client.query(
      `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
       VALUES ($1,$2,$3,$4,true,
         COALESCE((SELECT MAX(display_order)+10 FROM categories WHERE user_id=$1 AND pl_type=$4), 10))
       RETURNING id`,
      [USER_ID, parentId, name, plType]
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "不明なエラー" }, { status: 500 });
  } finally {
    client.release();
  }
}
