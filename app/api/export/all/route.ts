import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

// 全データをJSONで書き出し（バックアップ／データポータビリティ・ADR-053）。
// user_id を持つテーブルはそのまま、子テーブル（脚・明細行）は親経由で自分の分だけ抽出。
const OWNED = [
  "users",
  "wallets",
  "categories",
  "transactions",
  "transfers",
  "recurring_rules",
  "card_statements",
  "targets",
  "monthly_closings",
  "payslips",
  "balance_snapshots",
  "vision_notes",
  "notification_rules",
  "notification_log",
];

export async function GET() {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();

  const data: Record<string, unknown[]> = {};
  for (const t of OWNED) {
    // users テーブルだけは主キーが id（user_id 列を持たない）
    const col = t === "users" ? "id" : "user_id";
    const r = await pool.query(`SELECT * FROM ${t} WHERE ${col} = $1 ORDER BY id`, [USER_ID]);
    data[t] = r.rows;
  }
  // 子テーブル（user_idを持たない）は親の所有権で絞る
  data.transaction_legs = (
    await pool.query(
      `SELECT tl.* FROM transaction_legs tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE t.user_id = $1 ORDER BY tl.id`,
      [USER_ID]
    )
  ).rows;
  data.payslip_items = (
    await pool.query(
      `SELECT pi.* FROM payslip_items pi
       JOIN payslips p ON p.id = pi.payslip_id
       WHERE p.user_id = $1 ORDER BY pi.id`,
      [USER_ID]
    )
  ).rows;

  const body = JSON.stringify(
    { exported_at: new Date().toISOString(), user_id: USER_ID, data },
    null,
    2
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="pl-backup.json"`,
    },
  });
}
