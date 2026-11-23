// 固定費マスタの「1カテゴリ1ルール」ガード。
// 予実の突合キーが category_id だけなので、同一カテゴリに2本あると実額が両方に貼られ、
// 固定費が二重計上になる（tests/monthly-pl.test.ts で再現済み）。入口で塞ぐ。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, type Ids } from "./helpers/fixtures";
import { POST as postRule } from "@/app/api/recurring/route";
import { PUT as putRule } from "@/app/api/recurring/[id]/route";

let ids: Ids;

function body(ids: Ids, o: Partial<Record<string, unknown>> & { category: string; name: string }) {
  return {
    name: o.name,
    category_id: ids.cat[o.category],
    amount: o.amount ?? 5000,
    settlement_wallet_id: ids.wallet["銀行A"],
    start_month: o.start_month ?? "2026-04",
    billing_day: 1,
    billing_cycle: o.billing_cycle ?? "monthly",
    payment_month: o.payment_month,
    is_active: o.is_active,
  };
}
const post = (b: unknown) =>
  postRule(new Request("http://localhost/api/recurring", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  }));
const put = (id: number, b: unknown) =>
  putRule(
    new Request(`http://localhost/api/recurring/${id}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
    }),
    { params: Promise.resolve({ id: String(id) }) }
  );

beforeEach(async () => { ids = await resetDb(); });
afterAll(async () => { await pool.end(); });

describe("1カテゴリ1ルール（月額）", () => {
  it("同じカテゴリに2本目の月額ルールは409で拒否される", async () => {
    const r1 = await post(body(ids, { name: "スマホ", category: "通信費" }));
    expect(r1.status).toBe(200);

    const r2 = await post(body(ids, { name: "ネット回線", category: "通信費" }));
    expect(r2.status).toBe(409);
    const e = await r2.json();
    expect(e.error).toContain("スマホ");

    const c = await pool.query("select count(*)::int n from recurring_rules");
    expect(c.rows[0].n).toBe(1);
  });

  it("カテゴリが違えば2本目も作れる", async () => {
    expect((await post(body(ids, { name: "スマホ", category: "通信費" }))).status).toBe(200);
    expect((await post(body(ids, { name: "家賃", category: "家賃" }))).status).toBe(200);
    const c = await pool.query("select count(*)::int n from recurring_rules");
    expect(c.rows[0].n).toBe(2);
  });

  it("年額ルールは同じカテゴリに併存できる（月次PLに出ないため二重計上しない）", async () => {
    expect((await post(body(ids, { name: "月額", category: "通信費" }))).status).toBe(200);
    const r = await post(
      body(ids, { name: "年額", category: "通信費", billing_cycle: "yearly", payment_month: 4 })
    );
    expect(r.status).toBe(200);
  });

  it("解約済み(is_active=false)のルールがあるカテゴリには新規登録できる", async () => {
    const r1 = await post(body(ids, { name: "旧プラン", category: "通信費" }));
    const id1 = (await r1.json()).id;
    await pool.query("update recurring_rules set is_active=false where id=$1", [id1]);

    expect((await post(body(ids, { name: "新プラン", category: "通信費" }))).status).toBe(200);
  });

  it("更新で他ルールのカテゴリに移そうとすると409", async () => {
    await post(body(ids, { name: "スマホ", category: "通信費" }));
    const r2 = await post(body(ids, { name: "家賃", category: "家賃" }));
    const rentId = (await r2.json()).id;

    const res = await put(rentId, body(ids, { name: "家賃", category: "通信費" }));
    expect(res.status).toBe(409);
  });

  it("自分自身の更新（カテゴリ据え置き）は通る", async () => {
    const r1 = await post(body(ids, { name: "スマホ", category: "通信費" }));
    const id1 = (await r1.json()).id;
    const res = await put(id1, body(ids, { name: "スマホ(値上げ)", category: "通信費", amount: 6000 }));
    expect(res.status).toBe(200);
    const row = await pool.query("select name, amount from recurring_rules where id=$1", [id1]);
    expect(row.rows[0]).toEqual({ name: "スマホ(値上げ)", amount: 6000 });
  });
});
