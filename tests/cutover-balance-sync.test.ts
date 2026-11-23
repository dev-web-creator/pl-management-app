// カットオーバー作業の検証：
// db/cleanup/002_sync_initial_balance.sql が、脚や振替が既に入っていても
// 「算出残高 = 実残高」に正しく合わせられるか。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { getWalletBalances, getAssets } from "@/lib/queries";

let ids: Ids;

// BEGIN/COMMIT はテスト内で既に接続単位に管理されるので取り除いて流す
const SYNC_SQL = readFileSync("db/cleanup/002_sync_initial_balance.sql", "utf8")
  .replace(/^BEGIN;$/m, "")
  .replace(/^COMMIT;$/m, "");

async function snapshot(ids: Ids, wallet: string, date: string, actual: number) {
  await pool.query(
    `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
     VALUES ($1,$2,$3,$4)`,
    [ids.userId, ids.wallet[wallet], date, actual]
  );
}
const computed = async (name: string) =>
  (await getWalletBalances()).find((b) => b.name === name)?.balance ?? 0;

beforeEach(async () => { ids = await resetDb(); });
afterAll(async () => { await pool.end(); });

describe("期首残高の同期スクリプト", () => {
  it("脚も振替も無いウォレットを実残高に合わせる", async () => {
    // 銀行A は initial 500,000。実残高は 723,456 だったとする
    await snapshot(ids, "銀行A", "2026-09-30", 723456);
    await pool.query(SYNC_SQL);
    expect(await computed("銀行A")).toBe(723456);
  });

  it("脚が入っているウォレットでも正しく合う（差分方式）", async () => {
    // 支出 30,000 を銀行Aで記録 → 算出残高 470,000
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "銀行A" });
    expect(await computed("銀行A")).toBe(470000);

    await snapshot(ids, "銀行A", "2026-09-30", 723456);
    await pool.query(SYNC_SQL);

    expect(await computed("銀行A")).toBe(723456);
    // 期首残高は 723,456 ではなく、脚の分を戻した 753,456 になっているはず
    const r = await pool.query("select initial_balance from wallets where id=$1", [ids.wallet["銀行A"]]);
    expect(r.rows[0].initial_balance).toBe(753456);
  });

  it("振替が入っていても正しく合う", async () => {
    await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, fee, kind, transfer_date)
       VALUES ($1,$2,$3,50000,220,'transfer','2026-09-15')`,
      [ids.userId, ids.wallet["銀行A"], ids.wallet["現金"]]
    );
    await snapshot(ids, "銀行A", "2026-09-30", 400000);
    await snapshot(ids, "現金", "2026-09-30", 65000);
    await pool.query(SYNC_SQL);

    expect(await computed("銀行A")).toBe(400000);
    expect(await computed("現金")).toBe(65000);
  });

  it("複数回流しても値が動かない（冪等）", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "銀行A" });
    await snapshot(ids, "銀行A", "2026-09-30", 723456);

    await pool.query(SYNC_SQL);
    const first = await computed("銀行A");
    await pool.query(SYNC_SQL);
    await pool.query(SYNC_SQL);
    expect(await computed("銀行A")).toBe(first);
  });

  it("最新のスナップショットだけを見る（古い記録に引きずられない）", async () => {
    await snapshot(ids, "銀行A", "2026-06-30", 100000);
    await snapshot(ids, "銀行A", "2026-09-30", 723456);
    await pool.query(SYNC_SQL);
    expect(await computed("銀行A")).toBe(723456);
  });

  it("スナップショットの無いウォレットは触らない", async () => {
    await snapshot(ids, "銀行A", "2026-09-30", 723456);
    await pool.query(SYNC_SQL);
    const r = await pool.query("select initial_balance from wallets where id=$1", [ids.wallet["現金"]]);
    expect(r.rows[0].initial_balance).toBe(20000); // フィクスチャのまま
  });

  it("crypto は触らない（スナップショットが直接「正」のため）", async () => {
    const r = await pool.query(
      `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets)
       VALUES ($1,'ETH','crypto',0,true) RETURNING id`, [ids.userId]
    );
    ids.wallet["ETH"] = r.rows[0].id;
    await snapshot(ids, "ETH", "2026-09-30", 52000);
    await pool.query(SYNC_SQL);

    const after = await pool.query("select initial_balance from wallets where id=$1", [ids.wallet["ETH"]]);
    expect(after.rows[0].initial_balance).toBe(0); // 変更されない
    expect(await computed("ETH")).toBe(52000);     // 表示はスナップショット由来で正しい
  });

  it("同期後の総資産が実残高の合計と一致する", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "銀行A" });
    await snapshot(ids, "銀行A", "2026-09-30", 400000);
    await snapshot(ids, "現金", "2026-09-30", 35000);
    await pool.query(SYNC_SQL);

    const a = await getAssets();
    console.log(`\n[カットオーバー後] 総資産=${a.total_assets}（期待: 435,000）`);
    expect(a.total_assets).toBe(435000);
  });
});
