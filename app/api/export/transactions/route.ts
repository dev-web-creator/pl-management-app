import pool from "@/lib/db";
import { requireAuthApi, currentUserId } from "@/lib/auth";

// 取引をCSVで書き出し（データポータビリティ / ADR-053）。
// Excel(日本語)で文字化けしないよう UTF-8 BOM を付与。
export async function GET() {
  const denied = await requireAuthApi();
  if (denied) return denied;
  const USER_ID = await currentUserId();

  const { rows } = await pool.query(
    `SELECT to_char(t.accrual_date,'YYYY-MM-DD') AS date,
            CASE t.type WHEN 'income' THEN '収入' ELSE '支出' END AS type,
            c.name AS category, c.pl_type,
            t.amount, t.memo, t.mood,
            COALESCE(string_agg(w.name || '(' || tl.amount || ')', ' + ' ORDER BY tl.id), '') AS wallets,
            to_char(t.created_at,'YYYY-MM-DD HH24:MI') AS created_at
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN transaction_legs tl ON tl.transaction_id = t.id
     LEFT JOIN wallets w ON w.id = tl.wallet_id
     WHERE t.user_id = $1
     GROUP BY t.id, c.name, c.pl_type
     ORDER BY t.accrual_date, t.id`,
    [USER_ID]
  );

  const header = ["日付", "種別", "カテゴリ", "PL区分", "金額", "決済手段", "メモ", "気分", "登録日時"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.date, r.type, r.category, r.pl_type, r.amount, r.wallets, r.memo, r.mood ?? "", r.created_at]
        .map(esc)
        .join(",")
    );
  }
  const csv = "﻿" + lines.join("\r\n"); // BOM + CRLF

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="transactions.csv"`,
    },
  });
}
