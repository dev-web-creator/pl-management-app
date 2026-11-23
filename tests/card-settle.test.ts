// クレカ消込。1回の金額が最も大きい経路なので、二重消込は実害が大きい
//（銀行から請求額がもう一度引かれる）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { POST as settle } from "@/app/api/cards/settle/route";
import { getAssets, getWalletBalances } from "@/lib/queries";

let ids: Ids;

const req = (b: unknown) =>
  settle(new Request("http://localhost/api/cards/settle", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  }));
const body = (ids: Ids, o?: Partial<{ close_key: string; amount: number; pay_date: string }>) => ({
  card_id: ids.wallet["クレカA"],
  close_key: o?.close_key ?? "2026-09-15",
  amount: o?.amount ?? 30000,
  pay_date: o?.pay_date ?? "2026-10-10",
});
const settlements = () =>
  pool.query("select count(*)::int n, coalesce(sum(amount),0)::int s from transfers where kind='card_settlement'");

beforeEach(async () => {
  ids = await resetDb();
  // クレカで30,000使った状態を作る
  await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
});
afterAll(async () => { await pool.end(); });

describe("カード消込", () => {
  it("消込すると未払いが消え、銀行から引き落とされる", async () => {
    const before = await getAssets();
    expect(before.card_unpaid).toBe(30000);
    expect(before.total_assets).toBe(520000);

    expect((await req(body(ids))).status).toBe(200);

    const after = await getAssets();
    expect(after.card_unpaid).toBe(0);
    expect(after.total_assets).toBe(490000); // 銀行から30,000引かれる
    expect(after.net_assets).toBe(before.net_assets); // 純資産は変わらない
  });

  it("同じ締めサイクルの2回目は409で拒否される", async () => {
    expect((await req(body(ids))).status).toBe(200);
    const second = await req(body(ids));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("既に消込済み");

    const s = await settlements();
    expect(s.rows[0]).toEqual({ n: 1, s: 30000 });
  });

  it("【砦】アプリの重複チェックを外してもDB索引が二重消込を止める", async () => {
    // アプリ側の事前SELECTをすり抜けた状況を、直接INSERTで再現する
    await req(body(ids));
    const memo = "クレカ消込:2026-09-15締め";
    await expect(
      pool.query(
        `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, kind, transfer_date, memo)
         VALUES ($1,$2,$3,30000,'card_settlement','2026-10-10',$4)`,
        [ids.userId, ids.wallet["銀行A"], ids.wallet["クレカA"], memo]
      )
    ).rejects.toMatchObject({ code: "23505" });

    const s = await settlements();
    expect(s.rows[0].n).toBe(1);
  });

  it("締めサイクルが違えば消込できる", async () => {
    expect((await req(body(ids, { close_key: "2026-09-15" }))).status).toBe(200);
    expect((await req(body(ids, { close_key: "2026-10-15", pay_date: "2026-11-10" }))).status).toBe(200);
    expect((await settlements()).rows[0].n).toBe(2);
  });

  it("引落先の残高にも正しく反映される", async () => {
    await req(body(ids));
    const bal = await getWalletBalances();
    expect(bal.find((b) => b.name === "銀行A")?.balance).toBe(470000);
    expect(bal.find((b) => b.name === "クレカA")).toBeUndefined(); // 残高0なので非表示
  });

  it("不正な入力は400で弾かれ、消込は作られない", async () => {
    expect((await req({ ...body(ids), amount: 0 })).status).toBe(400);
    expect((await req({ ...body(ids), close_key: "2026-9-15" })).status).toBe(400);
    expect((await req({ ...body(ids), card_id: undefined })).status).toBe(400);
    expect((await settlements()).rows[0].n).toBe(0);
  });
});
