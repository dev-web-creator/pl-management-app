// 「内訳の合計 = サマリの値」という内部整合を守る回帰テスト。
// 費目を細分化したり無効化したりする通常運用で、/monthly の数字だけが
// 静かに小さくなる問題（明細から金額が消える）を防ぐ。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import {
  getVariableLeaves, getVariableGroups, getPLSummary, getMonthlyIncomeRows,
} from "@/lib/queries";

let ids: Ids;
const P = "2026-09-01";

const leavesTotal = async () => (await getVariableLeaves(P)).reduce((s, r) => s + r.total, 0);
const groupsTotal = async () => (await getVariableGroups(P)).reduce((s, r) => s + r.total, 0);
const incomeTotal = async () =>
  (await getMonthlyIncomeRows(P)).filter((r) => r.pl_type === "income").reduce((s, r) => s + r.total, 0);

async function addChild(ids: Ids, parent: string, name: string) {
  const r = await pool.query(
    `INSERT INTO categories (user_id, parent_id, name, pl_type) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ids.userId, ids.cat[parent], name, "variable_cost"]
  );
  ids.cat[name] = r.rows[0].id;
  // アプリのカテゴリ作成APIと同じく、親は入力不可にする
  await pool.query(`UPDATE categories SET is_input_allowed=false WHERE id=$1`, [ids.cat[parent]]);
  return r.rows[0].id as number;
}

beforeEach(async () => {
  ids = await resetDb();
  await addTx(ids, { category: "食料品", type: "expense", amount: 3000, date: "2026-09-05", wallet: "現金" });
  await addTx(ids, { category: "外食", type: "expense", amount: 2000, date: "2026-09-06", wallet: "現金" });
  await addTx(ids, { category: "日用品", type: "expense", amount: 5000, date: "2026-09-07", wallet: "現金" });
});
afterAll(async () => { await pool.end(); });

describe("変動費: 明細と合計の整合", () => {
  it("初期状態で 明細合計 = グループ合計 = PLサマリ", async () => {
    expect(await leavesTotal()).toBe(10000);
    expect(await groupsTotal()).toBe(10000);
    expect((await getPLSummary(P)).variable).toBe(10000);
  });

  it("取引のある費目に子を追加しても、明細合計が変わらない", async () => {
    await addChild(ids, "日用品", "洗剤"); // 日用品(5,000の実績あり)が親になる
    const leaves = await getVariableLeaves(P);
    console.log(`\n[子追加後] ${leaves.map((r) => `${r.name}=${r.total}`).join(", ")}`);

    expect(await leavesTotal()).toBe(10000);       // 5,000が消えない
    expect(await groupsTotal()).toBe(10000);
    expect((await getPLSummary(P)).variable).toBe(10000);
    expect(leaves.map((r) => r.name)).toContain("日用品"); // 親の行が残る
  });

  it("費目を無効化しても、その月の実績は明細に残る", async () => {
    await pool.query(`UPDATE categories SET is_active=false WHERE id=$1`, [ids.cat["外食"]]);
    const leaves = await getVariableLeaves(P);
    console.log(`[無効化後] ${leaves.map((r) => `${r.name}=${r.total}`).join(", ")}`);

    expect(await leavesTotal()).toBe(10000);       // 2,000が消えない
    expect(await groupsTotal()).toBe(10000);
    expect((await getPLSummary(P)).variable).toBe(10000);
  });

  it("実績が無い無効化費目は明細から消える（表示は汚さない）", async () => {
    await pool.query(`UPDATE categories SET is_active=false WHERE id=$1`, [ids.cat["外食"]]);
    const other = await getVariableLeaves("2026-08-01"); // 実績の無い月
    expect(other.map((r) => r.name)).not.toContain("外食");
  });

  it("子追加と無効化を重ねても整合が崩れない", async () => {
    await addChild(ids, "日用品", "洗剤");
    await addChild(ids, "食費", "カフェ");
    await pool.query(`UPDATE categories SET is_active=false WHERE id=$1`, [ids.cat["外食"]]);

    expect(await leavesTotal()).toBe(10000);
    expect(await groupsTotal()).toBe(10000);
    expect((await getPLSummary(P)).variable).toBe(10000);
  });
});

describe("収入: 明細と合計の整合", () => {
  beforeEach(async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-09-25", wallet: "銀行A" });
    await addTx(ids, { category: "副業収入", type: "income", amount: 47000, date: "2026-09-20", wallet: "銀行A" });
  });

  it("初期状態で 収入明細合計 = 可処分所得", async () => {
    expect(await incomeTotal()).toBe(347000);
    expect((await getPLSummary(P)).disposable).toBe(347000);
  });

  it("収入費目を無効化しても実績が明細に残る", async () => {
    await pool.query(`UPDATE categories SET is_active=false WHERE id=$1`, [ids.cat["副業収入"]]);
    const rows = await getMonthlyIncomeRows(P);
    console.log(`[収入・無効化後] ${rows.filter(r=>r.pl_type==="income").map((r) => `${r.name}=${r.total}`).join(", ")}`);

    expect(await incomeTotal()).toBe(347000);
    expect((await getPLSummary(P)).disposable).toBe(347000);
  });

  it("収入費目に子を追加しても実績が明細に残る", async () => {
    const r = await pool.query(
      `INSERT INTO categories (user_id, parent_id, name, pl_type) VALUES ($1,$2,'ブログ収入','income') RETURNING id`,
      [ids.userId, ids.cat["副業収入"]]
    );
    expect(r.rowCount).toBe(1);
    expect(await incomeTotal()).toBe(347000);
    expect((await getPLSummary(P)).disposable).toBe(347000);
  });
});
