// 月次PL・固定費の予実突合。並行運用の「先月をシートと突合する」動線に直結する。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, monthStart, dayOf, type Ids } from "./helpers/fixtures";
import { getFixedCostPlanVsActual, getPLSummary } from "@/lib/queries";

let ids: Ids;

// app/page.tsx:18 と同じ実装
const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

async function addRule(
  ids: Ids,
  o: { name: string; category: string; amount: number; start: string; cycle?: string; day?: number }
) {
  const r = await pool.query(
    `INSERT INTO recurring_rules (user_id, name, category_id, amount, billing_day, start_month, billing_cycle, settlement_wallet_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
    [ids.userId, o.name, ids.cat[o.category], o.amount, o.day ?? 1, o.start, o.cycle ?? "monthly", ids.wallet["銀行A"]]
  );
  return r.rows[0].id as number;
}

beforeEach(async () => { ids = await resetDb(); });
afterAll(async () => { await pool.end(); });

describe("T09 過去月で実額が無い固定費", () => {
  it("is_actual=true なのに actual=null が返り、画面の整形関数が例外を投げる", async () => {
    // 2026-04開始の家賃ルール。過去月(2026-08)には実額の取引を入れない。
    await addRule(ids, { name: "家賃", category: "家賃", amount: 129987, start: "2026-04-01" });

    const rows = await getFixedCostPlanVsActual("2026-08-01"); // 今日=2026-09-21 なので過去月
    expect(rows).toHaveLength(1);
    const f = rows[0];
    console.log(`\n[T09] is_actual=${f.is_actual} / actual=${f.actual} / plan=${f.plan} / effective=${f.effective}`);

    // 不整合そのもの
    expect(f.is_actual).toBe(true);
    expect(f.actual).toBeNull();

    // 修正前の app/page.tsx:265 の式は例外になる（バグの記録）
    expect(() => yen(f.is_actual ? (f.actual as unknown as number) : f.plan)).toThrow(TypeError);

    // 修正後の式（effective を使う / monthly と同じ）は例外にならず ¥0 を返す
    expect(f.effective).toBe(0);
    expect(yen(f.effective)).toBe("¥0");
  });

  it("【回帰】effective は4パターンすべてで null にならない", async () => {
    await addRule(ids, { name: "家賃", category: "家賃", amount: 129987, start: "2026-04-01" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 120000, date: "2026-07-01", wallet: "銀行A" });

    const cases: [string, string][] = [
      ["2026-07-01", "過去月・実額あり"],
      ["2026-08-01", "過去月・実額なし"],
      [await monthStart(0), "当月・実額なし"],
      [await monthStart(1), "未来月・実額なし"],
    ];
    for (const [period, label] of cases) {
      const row = (await getFixedCostPlanVsActual(period))[0];
      expect(row.effective, label).not.toBeNull();
      expect(() => yen(row.effective), label).not.toThrow();
    }
  });

  it("実額がある過去月なら整合し、例外も起きない", async () => {
    await addRule(ids, { name: "家賃", category: "家賃", amount: 129987, start: "2026-04-01" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 129987, date: "2026-08-01", wallet: "銀行A" });

    const f = (await getFixedCostPlanVsActual("2026-08-01"))[0];
    expect(f.is_actual).toBe(true);
    expect(f.actual).toBe(129987);
    expect(() => yen(f.actual as number)).not.toThrow();
  });

  it("当月は実額が無くても予定額でフォールバックし、例外は起きない（ADR-030）", async () => {
    await addRule(ids, { name: "家賃", category: "家賃", amount: 129987, start: "2026-04-01" });
    const f = (await getFixedCostPlanVsActual(await monthStart(0)))[0]; // 当月
    expect(f.is_actual).toBe(false);
    expect(f.effective).toBe(129987);
    expect(() => yen(f.is_actual ? (f.actual as unknown as number) : f.plan)).not.toThrow();
  });
});

describe("固定費の予実突合キー", () => {
  it("同じカテゴリに固定費ルールが2本あると、同じ実額が両方に貼られる", async () => {
    // 「通信費」カテゴリにスマホとネット回線の2本を登録（現実的な運用）
    await addRule(ids, { name: "スマホ", category: "通信費", amount: 5000, start: "2026-04-01" });
    await addRule(ids, { name: "ネット回線", category: "通信費", amount: 4000, start: "2026-04-01" });
    // 実額はスマホ分の5,000だけ記録
    await addTx(ids, { category: "通信費", type: "expense", amount: 5000, date: "2026-09-05", wallet: "銀行A" });

    const rows = await getFixedCostPlanVsActual("2026-09-01");
    const total = rows.reduce((s, r) => s + r.effective, 0);
    console.log(
      `\n[固定費] 行ごとの実額: ${rows.map((r) => `${r.name}=${r.actual}`).join(", ")} / effective合計=${total}`
    );

    expect(rows).toHaveLength(2);
    // 実際に払ったのは5,000なのに、両方の行に5,000が貼られる
    expect(rows.every((r) => r.actual === 5000)).toBe(true);
    expect(total).toBe(10000); // 実支出5,000の2倍
  });

  it("カテゴリが分かれていれば正しく突合される", async () => {
    await addRule(ids, { name: "スマホ", category: "通信費", amount: 5000, start: "2026-04-01" });
    await addRule(ids, { name: "家賃", category: "家賃", amount: 129987, start: "2026-04-01" });
    const cur = await monthStart(0); // 「当月なので予定でフォールバック」を見るため当月で検証する
    await addTx(ids, { category: "通信費", type: "expense", amount: 5000, date: dayOf(cur, 5), wallet: "銀行A" });

    const rows = await getFixedCostPlanVsActual(cur);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["スマホ"].actual).toBe(5000);
    expect(byName["家賃"].actual).toBeNull();
    expect(byName["家賃"].effective).toBe(129987); // 当月なので予定でフォールバック
  });
});

describe("年額サブスクが月次PLに漏れないこと（ADR-035）", () => {
  it("billing_cycle='yearly' のルールは固定費の予実に出てこない", async () => {
    await addRule(ids, { name: "月額", category: "通信費", amount: 5000, start: "2026-04-01" });
    await addRule(ids, {
      name: "年額サブスク", category: "年額サブスク", amount: 120000, start: "2026-04-01", cycle: "yearly",
    });
    const rows = await getFixedCostPlanVsActual("2026-09-01");
    expect(rows.map((r) => r.name)).toEqual(["月額"]);
  });
});

describe("PLサマリの基本整合", () => {
  it("収入・固定費・変動費・対象外が正しく仕分けられる", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 400000, date: "2026-09-05", wallet: "銀行A" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 130000, date: "2026-09-01", wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 20000, date: "2026-09-10", wallet: "銀行A" });
    await addTx(ids, { category: "外食", type: "expense", amount: 5000, date: "2026-09-11", wallet: "現金" });
    await addTx(ids, { category: "投資", type: "expense", amount: 50000, date: "2026-09-12", wallet: "銀行A" });

    const pl = await getPLSummary("2026-09-01");
    console.log(`\n[PL] ${JSON.stringify(pl)}`);
    expect(pl.disposable).toBe(400000);
    expect(pl.fixed).toBe(130000);
    expect(pl.variable).toBe(25000);
    expect(pl.excluded).toBe(50000); // 投資は対象外でPLに含まない
    expect(pl.surplus).toBe(400000 - 130000 - 25000);
  });

  it("隣の月の取引が混入しない（月境界）", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: "2026-08-31", wallet: "現金" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 2000, date: "2026-09-01", wallet: "現金" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 4000, date: "2026-09-30", wallet: "現金" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 8000, date: "2026-10-01", wallet: "現金" });

    const pl = await getPLSummary("2026-09-01");
    expect(pl.variable).toBe(6000); // 9/1 と 9/30 のみ
  });
});
