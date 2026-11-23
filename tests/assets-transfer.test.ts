// 振替と資産計算。とくに暗号資産(crypto)の残高だけ別ルール（最新スナップショットが正・ADR-043）
// になっている点が、振替と噛み合うかを確かめる。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { getAssets, getWalletBalances } from "@/lib/queries";

let ids: Ids;

async function addCryptoWallet(ids: Ids, name: string) {
  const r = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets)
     VALUES ($1,$2,'crypto',0,true) RETURNING id`,
    [ids.userId, name]
  );
  ids.wallet[name] = r.rows[0].id;
  return r.rows[0].id as number;
}

async function transfer(ids: Ids, from: string, to: string, amount: number, fee = 0) {
  await pool.query(
    `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, fee, kind, transfer_date)
     VALUES ($1,$2,$3,$4,$5,'transfer','2026-09-15')`,
    [ids.userId, ids.wallet[from], ids.wallet[to], amount, fee]
  );
}

beforeEach(async () => { ids = await resetDb(); });
afterAll(async () => { await pool.end(); });

describe("振替はPLに影響しない", () => {
  it("銀行→現金の振替で総資産が変わらない", async () => {
    const before = await getAssets();
    await transfer(ids, "銀行A", "現金", 50000);
    const after = await getAssets();
    expect(after.total_assets).toBe(before.total_assets);
  });

  it("手数料つき振替は手数料分だけ総資産が減る", async () => {
    const before = await getAssets();
    await transfer(ids, "銀行A", "現金", 50000, 220);
    const after = await getAssets();
    expect(before.total_assets - after.total_assets).toBe(220);
  });
});

describe("暗号資産ウォレットへの振替", () => {
  it("評価額スナップショットが無いcryptoへ振替すると、総資産から金額が消える", async () => {
    await addCryptoWallet(ids, "ETH");
    const before = await getAssets();
    expect(before.total_assets).toBe(520000);

    await transfer(ids, "銀行A", "ETH", 50000);

    const after = await getAssets();
    const bal = await getWalletBalances();
    console.log(
      `\n[crypto] 総資産: ${before.total_assets} → ${after.total_assets} (差 ${after.total_assets - before.total_assets}) / ETH残高表示: ${bal.find((b) => b.name === "ETH")?.balance ?? "（0のため非表示）"}`
    );

    // スナップショットが無い場合は通常計算（initial+脚+振替）に乗るので保存される
    expect(after.total_assets).toBe(520000);
  });

  it("評価額スナップショットがあるcryptoへ振替しても総資産が保たれる", async () => {
    const eth = await addCryptoWallet(ids, "ETH");
    // 評価額を10,000で手入力（ADR-043の想定運用）
    await pool.query(
      `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
       VALUES ($1,$2,'2026-09-01',10000)`,
      [ids.userId, eth]
    );
    const before = await getAssets();
    expect(before.total_assets).toBe(520000 + 10000);

    await transfer(ids, "銀行A", "ETH", 50000);

    const after = await getAssets();
    console.log(
      `\n[crypto+snapshot] 総資産: ${before.total_assets} → ${after.total_assets} (差 ${after.total_assets - before.total_assets})`
    );

    // 【修正後】スナップショット日より後の振替は加算されるので、総資産は保たれる
    expect(after.total_assets).toBe(530000);
  });

  it("スナップショットより前の振替は二重に足さない（既に評価額へ織り込み済み）", async () => {
    const eth = await addCryptoWallet(ids, "ETH");
    // 9/15に振替 → 9/20に評価額を入力（振替後の残高を見て入力したはず）
    await transfer(ids, "銀行A", "ETH", 50000); // transfer_date = 2026-09-15
    await pool.query(
      `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
       VALUES ($1,$2,'2026-09-20',60000)`,
      [ids.userId, eth]
    );
    const a = await getAssets();
    console.log(`
[crypto 振替→評価額の順] 総資産=${a.total_assets}`);
    // 銀行 450,000 + 現金 20,000 + ETH 60,000（スナップショットのみ）= 530,000
    expect(a.total_assets).toBe(530000);
  });

  it("cryptoからの出金もスナップショット後なら反映される", async () => {
    const eth = await addCryptoWallet(ids, "ETH");
    await pool.query(
      `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
       VALUES ($1,$2,'2026-09-01',100000)`,
      [ids.userId, eth]
    );
    const before = await getAssets();
    expect(before.total_assets).toBe(520000 + 100000);

    await transfer(ids, "ETH", "銀行A", 30000); // 9/15にETHから銀行へ

    const after = await getAssets();
    console.log(`
[crypto 出金] 総資産: ${before.total_assets} → ${after.total_assets}`);
    expect(after.total_assets).toBe(620000); // 総額は変わらない（ETH -30,000 / 銀行 +30,000）
  });
});

describe("クレジットカードの扱い", () => {
  it("カード払いの支出は総資産を減らさず、カード未払いを増やす", async () => {
    const before = await getAssets();
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
    const after = await getAssets();

    expect(after.total_assets).toBe(before.total_assets); // 現預金は減らない
    expect(after.card_unpaid).toBe(30000);
    expect(after.net_assets).toBe(before.net_assets - 30000); // 純資産は減る
  });
});
