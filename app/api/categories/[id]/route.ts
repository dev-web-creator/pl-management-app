import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

// 費目のリネーム / 有効・無効切替（ADR-050）。PL区分・親は変更不可（安全側）。
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const cid = Number(id);
  if (!Number.isInteger(cid) || cid <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  let b: { name?: string; is_active?: boolean };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSONが不正です" }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof b.name === "string") {
    const name = b.name.trim().slice(0, 40);
    if (!name) return NextResponse.json({ ok: false, error: "費目名は空にできません" }, { status: 400 });
    vals.push(name);
    sets.push(`name=$${vals.length}`);
  }
  if (typeof b.is_active === "boolean") {
    // 無効化する場合、アクティブな子が残っていないか確認
    if (!b.is_active) {
      const ch = await pool.query(
        `SELECT 1 FROM categories WHERE parent_id=$1 AND is_active LIMIT 1`,
        [cid]
      );
      if (ch.rowCount && ch.rowCount > 0) {
        return NextResponse.json({ ok: false, error: "先に配下の費目を無効化してください" }, { status: 409 });
      }
    }
    vals.push(b.is_active);
    sets.push(`is_active=$${vals.length}`);
  }
  if (sets.length === 0) {
    return NextResponse.json({ ok: false, error: "更新項目がありません" }, { status: 400 });
  }
  vals.push(cid, USER_ID);
  const r = await pool.query(
    `UPDATE categories SET ${sets.join(", ")} WHERE id=$${vals.length - 1} AND user_id=$${vals.length}`,
    vals
  );
  if (r.rowCount === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

// 費目の削除（ADR-050）。取引・子が無ければ物理削除。あれば無効化を案内。
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();
  const { id } = await params;
  const cid = Number(id);
  if (!Number.isInteger(cid) || cid <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const owned = await pool.query(`SELECT 1 FROM categories WHERE id=$1 AND user_id=$2`, [cid, USER_ID]);
  if (owned.rowCount === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  const refs = await pool.query(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE category_id=$1)
          + (SELECT COUNT(*) FROM categories WHERE parent_id=$1)
          + (SELECT COUNT(*) FROM recurring_rules WHERE category_id=$1) AS cnt`,
    [cid]
  );
  if (Number(refs.rows[0].cnt) > 0) {
    return NextResponse.json(
      { ok: false, error: "この費目は取引や子費目で使われています。削除できないので「無効化」してください" },
      { status: 409 }
    );
  }
  await pool.query(`DELETE FROM categories WHERE id=$1 AND user_id=$2`, [cid, USER_ID]);
  return NextResponse.json({ ok: true, deleted: true });
}
