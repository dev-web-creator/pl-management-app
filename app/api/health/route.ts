import { NextResponse } from "next/server";
import pool from "@/lib/db";

export async function GET() {
  const result = await pool.query(
    "SELECT tbl, cnt FROM (VALUES ('wallets',(SELECT count(*)::int FROM wallets)),('categories',(SELECT count(*)::int FROM categories)),('recurring_rules',(SELECT count(*)::int FROM recurring_rules))) AS t(tbl,cnt)"
  );
  return NextResponse.json({ ok: true, counts: result.rows });
}
