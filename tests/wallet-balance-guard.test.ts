// 期首残高(initial_balance)の保全。
// 10/1カットオーバーで各ウォレットに9/30時点の実残高を入れる。その値が
// 「名前を直しただけ」で0に戻ると、総資産が丸ごと壊れる。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, type Ids } from "./helpers/fixtures";
import { PUT as putWallet } from "@/app/api/wallets/[id]/route";
import { getAssets } from "@/lib/queries";

let ids: Ids;

function put(id: number, b: unknown) {
  return putWallet(
    new Request(`http://localhost/api/wallets/${id}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
    }),
    { params: Promise.resolve({ id: String(id) }) }
  );
}
const balanceOf = async (id: number) =>
  (await pool.query("select initial_balance from wallets where id=$1", [id])).rows[0].initial_balance;

beforeEach(async () => { ids = await resetDb(); });
afterAll(async () => { await pool.end(); });

describe("期首残高の保全", () => {
  it("initial_balance を送らない更新では既存値が保たれる", async () => {
    const id = ids.wallet["銀行A"];
    expect(await balanceOf(id)).toBe(500000);

    const res = await put(id, { name: "みずほ銀行", type: "bank" }); // initial_balance を含めない
    expect(res.status).toBe(200);

    expect(await balanceOf(id)).toBe(500000); // 0に戻らない
    const n = await pool.query("select name from wallets where id=$1", [id]);
    expect(n.rows[0].name).toBe("みずほ銀行"); // 名前の変更は効いている
  });

  it("initial_balance を明示すれば更新される", async () => {
    const id = ids.wallet["銀行A"];
    expect((await put(id, { name: "銀行A", type: "bank", initial_balance: 723456 })).status).toBe(200);
    expect(await balanceOf(id)).toBe(723456);
  });

  it("initial_balance に明示的な0を送れば0になる", async () => {
    const id = ids.wallet["銀行A"];
    expect((await put(id, { name: "銀行A", type: "bank", initial_balance: 0 })).status).toBe(200);
    expect(await balanceOf(id)).toBe(0);
  });

  it("名前変更を繰り返しても総資産が変わらない", async () => {
    const before = await getAssets();
    expect(before.total_assets).toBe(520000);

    await put(ids.wallet["銀行A"], { name: "みずほ", type: "bank" });
    await put(ids.wallet["現金"], { name: "財布", type: "cash" });

    expect((await getAssets()).total_assets).toBe(520000);
  });
});
