// 月次明細の集計クエリ（/monthly・/calendar・/analytics の数字そのもの）。
//
// 主戦場は「月次突合」。ここで見たいのは例外ではなく "静かに金額がズレる" こと。
// そのため単体の値だけでなく、以下のクロス検証を必ず置く：
//   getVariableGroups(合計) == getVariableLeaves(合計) == getPLSummary().variable
//   sum(getDailyTotals) == getPLSummary()
//   sum(getMonthlyIncomeRows) == getPLSummary().disposable
//
// 期待値はすべて手計算のハードコード。金額は桁を散らして取り違えを検出しやすくしている。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import {
  getVariableGroups,
  getVariableLeaves,
  getMonthlyIncomeRows,
  getCategoryMoM,
  getMonthlySeries,
  getDailyTotals,
  getDayTransactions,
  getMonthTransactions,
  getPLSummary,
  getFixedCostPlanVsActual,
} from "@/lib/queries";
import { POST as CategoriesPOST } from "@/app/api/categories/route";
import { PUT as CategoryPUT } from "@/app/api/categories/[id]/route";

let ids: Ids;

/** 過去月。CURRENT_DATE に依存しない月をテストの既定にする（今日=2026-09-22） */
const M = "2026-06-01";

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

// ---- ローカルヘルパ（フィクスチャを汚さない範囲の小物） ----

/** 脚を複数持つ取引（分割払い）を作る */
async function addSplitTx(
  ids: Ids,
  o: { category: string; type: "expense" | "income"; date: string; legs: [string, number][] }
): Promise<number> {
  const total = o.legs.reduce((s, [, a]) => s + a, 0);
  const r = await pool.query(
    `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ids.userId, ids.cat[o.category], o.type, total, o.date]
  );
  const txId: number = r.rows[0].id;
  for (const [w, a] of o.legs) {
    await pool.query(
      `INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,$3)`,
      [txId, ids.wallet[w], a]
    );
  }
  return txId;
}

/** 費目を直接SQLで足す（APIを通さないケース用） */
async function addCategory(
  ids: Ids,
  o: { name: string; plType: string; parent?: string; inputAllowed?: boolean }
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ids.userId, o.parent ? ids.cat[o.parent] : null, o.name, o.plType, o.inputAllowed ?? true]
  );
  ids.cat[o.name] = r.rows[0].id;
  return ids.cat[o.name];
}

const sum = (rows: { total: number }[]) => rows.reduce((s, r) => s + r.total, 0);

// ============================================================
// 1. 変動費のロールアップ（getVariableGroups / getVariableLeaves）
// ============================================================
describe("変動費のロールアップ（3階層 変動費>食費>食料品）", () => {
  it("葉だけに金額があるとき、グループ合計・葉合計・PLサマリが1円まで一致する", async () => {
    // 食料品 12,345 / 外食 6,780 / 日用品 1,200 → 合計 20,325
    await addTx(ids, { category: "食料品", type: "expense", amount: 12345, date: "2026-06-03", wallet: "現金" });
    await addTx(ids, { category: "外食", type: "expense", amount: 6780, date: "2026-06-20", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 1200, date: "2026-06-30", wallet: "現金" });

    const groups = await getVariableGroups(M);
    const leaves = await getVariableLeaves(M);
    const pl = await getPLSummary(M);

    // ルートは「変動費」1本だけ。中間ノード(食費)は行にならない。
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("変動費");
    expect(groups[0].total).toBe(20325); // 二重計上していれば 食費ぶん 19,125 が上乗せされる

    // 葉は3行。中間ノード「食費」の行は出ず、group_name はすべてルート名。
    expect(leaves.map((l) => [l.name, l.group_name, l.total])).toEqual([
      ["食料品", "変動費", 12345],
      ["外食", "変動費", 6780],
      ["日用品", "変動費", 1200],
    ]);

    expect(sum(leaves)).toBe(20325);
    expect(pl.variable).toBe(20325);
    // クロス検証：/（サマリ）と /monthly が同じ数字になる
    expect(groups[0].total).toBe(sum(leaves));
    expect(groups[0].total).toBe(pl.variable);
  });

  it("同一カテゴリの複数取引は合算され、二重計上されない", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1111, date: "2026-06-01" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 2222, date: "2026-06-15" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 3333, date: "2026-06-30" });

    const groups = await getVariableGroups(M);
    const leaves = await getVariableLeaves(M);
    expect(groups[0].total).toBe(6666);
    expect(leaves.find((l) => l.name === "食料品")!.total).toBe(6666);
    expect((await getPLSummary(M)).variable).toBe(6666);
  });

  it("変動費カテゴリへの income 取引は、3つの集計すべてが同じく無視する", async () => {
    // 返金を収入として食料品に付けたケース。どこかだけ拾うと符号がズレる。
    await addTx(ids, { category: "食料品", type: "expense", amount: 5000, date: "2026-06-05" });
    await addTx(ids, { category: "食料品", type: "income", amount: 800, date: "2026-06-06" });

    expect((await getVariableGroups(M))[0].total).toBe(5000);
    expect(sum(await getVariableLeaves(M))).toBe(5000);
    expect((await getPLSummary(M)).variable).toBe(5000);
    // 収入側にも出ない（income カテゴリではないため）
    expect(sum(await getMonthlyIncomeRows(M))).toBe(0);
  });

  it("固定費・控除・PL対象外の支出は変動費に混ざらない", async () => {
    await addTx(ids, { category: "家賃", type: "expense", amount: 130000, date: "2026-06-01" });
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: "2026-06-25" });
    await addTx(ids, { category: "投資", type: "expense", amount: 100000, date: "2026-06-25" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 7777, date: "2026-06-10" });

    expect((await getVariableGroups(M))[0].total).toBe(7777);
    expect(sum(await getVariableLeaves(M))).toBe(7777);
    const pl = await getPLSummary(M);
    expect(pl.variable).toBe(7777);
    expect(pl.fixed).toBe(130000);
    expect(pl.excluded).toBe(100000);
  });

  it("取引ゼロの月でも例外にならず 0 が返る（null にならない）", async () => {
    const groups = await getVariableGroups("2026-02-01");
    const leaves = await getVariableLeaves("2026-02-01");
    const income = await getMonthlyIncomeRows("2026-02-01");

    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(0);
    expect(leaves).toHaveLength(3); // 入力可の葉は金額0でも行が出る
    expect(leaves.every((l) => l.total === 0)).toBe(true);
    expect(income).toHaveLength(2);
    expect(income.every((r) => r.total === 0)).toBe(true);
    expect(await getDailyTotals("2026-02-01")).toEqual([]);
    expect(await getMonthTransactions("2026-02-01")).toEqual([]);
    expect(await getCategoryMoM("2026-02-01")).toEqual([]);
  });

  it("月境界：前月末日・翌月1日は入らず、当月1日・末日は入る", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 100, date: "2026-05-31" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 200, date: "2026-06-01" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 400, date: "2026-06-30" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 800, date: "2026-07-01" });

    expect((await getVariableGroups(M))[0].total).toBe(600);
    expect(sum(await getVariableLeaves(M))).toBe(600);
    expect((await getPLSummary(M)).variable).toBe(600);
    expect((await getMonthTransactions(M)).length).toBe(2);
    expect((await getDailyTotals(M)).map((d) => d.date)).toEqual(["2026-06-01", "2026-06-30"]);
  });

  it("ルート兼葉の費目（seedの「支払い利息」型）は、グループにも葉にも1回だけ出る", async () => {
    await addCategory(ids, { name: "支払い利息", plType: "variable_cost" }); // parentなし・子なし
    await addTx(ids, { category: "支払い利息", type: "expense", amount: 4321, date: "2026-06-13" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: "2026-06-13" });

    const groups = await getVariableGroups(M);
    expect(groups.map((g) => [g.name, g.total])).toEqual([
      ["変動費", 1000],
      ["支払い利息", 4321],
    ]);

    const leaves = await getVariableLeaves(M);
    expect(leaves.filter((l) => l.name === "支払い利息")).toHaveLength(1);
    expect(leaves.find((l) => l.name === "支払い利息")).toMatchObject({
      group_name: "支払い利息", // 自分自身がグループになる
      total: 4321,
    });
    expect(sum(leaves)).toBe(5321);
    expect(groups.reduce((s, g) => s + g.total, 0)).toBe(5321);
    expect((await getPLSummary(M)).variable).toBe(5321);
  });

  it("入力不可の葉は、金額がある月だけ行に出る（ADR-047の取込用カテゴリ）", async () => {
    await addCategory(ids, { name: "取込用", plType: "variable_cost", parent: "変動費", inputAllowed: false });

    // 金額なし → 出ない
    expect((await getVariableLeaves(M)).map((l) => l.name)).toEqual(["食料品", "外食", "日用品"]);

    await addTx(ids, { category: "取込用", type: "expense", amount: 3300, date: "2026-06-11" });
    const leaves = await getVariableLeaves(M);
    expect(leaves.map((l) => l.name)).toEqual(["食料品", "外食", "日用品", "取込用"]);
    expect(leaves.find((l) => l.name === "取込用")!.total).toBe(3300);
    expect(sum(leaves)).toBe(3300);
    expect((await getVariableGroups(M))[0].total).toBe(3300);
  });
});

// ============================================================
// 2. 集計ノードに残った取引も明細に出る
// ============================================================
describe("集計ノード（中間ノード・後から親になった費目）に残った取引", () => {
  it("中間ノードに付いた取引も明細に出て、グループ合計・PLサマリと一致する", async () => {
    // 変動費(ルート) と 食費(中間) に直接ぶら下がった取引。
    // インポートや、後から子費目を足した運用で普通に発生する。
    await addTx(ids, { category: "変動費", type: "expense", amount: 500, date: "2026-06-02" });
    await addTx(ids, { category: "食費", type: "expense", amount: 9000, date: "2026-06-04" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 12345, date: "2026-06-05" });
    await addTx(ids, { category: "外食", type: "expense", amount: 6780, date: "2026-06-06" });
    // 総額 = 500 + 9000 + 12345 + 6780 = 28,625

    const groups = await getVariableGroups(M);
    const leaves = await getVariableLeaves(M);
    const pl = await getPLSummary(M);

    // ロールアップは正しい（各ノード1回ずつ・二重計上なし）
    expect(groups[0].total).toBe(28625);
    expect(pl.variable).toBe(28625);

    // 以前は葉(子を持たない費目)しか明細に出さず、中間ノードの 9,500 が丸ごと消えていた（バグ）。
    // 現在は「その月に取引がある費目」も明細に出すので、集計ノード自身が行になる。
    // 入力不可(is_input_allowed=false)の 変動費・食費 も、実績がある月だけ現れる。
    expect(leaves.map((l) => [l.name, l.group_name, l.total])).toEqual([
      ["変動費", "変動費", 500],
      ["食費", "変動費", 9000],
      ["食料品", "変動費", 12345],
      ["外食", "変動費", 6780],
      ["日用品", "変動費", 0],
    ]);

    // クロス検証：/monthly の変動費合計と /（サマリ）が1円まで一致する
    expect(sum(leaves)).toBe(28625);
    expect(groups[0].total - sum(leaves)).toBe(0);
    expect(sum(leaves)).toBe(pl.variable);
  });

  it("POST /api/categories で子を足しても、親に残った既存取引は /monthly から消えない", async () => {
    // 日用品（葉・入力可）に 4,400 円の実績がある
    await addTx(ids, { category: "日用品", type: "expense", amount: 4400, date: "2026-06-07" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 10000, date: "2026-06-08" });

    const before = await getVariableLeaves(M);
    expect(sum(before)).toBe(14400);
    expect((await getVariableGroups(M))[0].total).toBe(14400);

    // ユーザーが「日用品」の下に「洗剤」を作る。
    // API は親を集計ノード化（is_input_allowed=false）するが、過去の取引は親に残る。
    const res = await CategoriesPOST(
      new Request("http://test/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "洗剤", pl_type: "variable_cost", parent_id: ids.cat["日用品"] }),
      })
    );
    expect(res.status).toBe(200);

    const after = await getVariableLeaves(M);
    // 以前は子を足した瞬間に親の 4,400 が /monthly から消え、サマリと 4,400 円ズレた（バグ）。
    // 現在は親（入力不可になった 日用品）が実績つきの行として残り、新しい子 洗剤 は 0 円で並ぶ。
    expect(after.map((l) => l.name)).toEqual(["食料品", "外食", "日用品", "洗剤"]);
    expect(after.find((l) => l.name === "日用品")!.total).toBe(4400);
    expect(after.find((l) => l.name === "洗剤")!.total).toBe(0);

    // 合計は子を足す前後で変わらない＝サマリとの突合がズレない
    expect(sum(after)).toBe(14400);
    expect(sum(after)).toBe(sum(before));
    expect((await getVariableGroups(M))[0].total).toBe(14400);
    expect((await getPLSummary(M)).variable).toBe(14400);
  });

  it("収入側も同じ：親になった収入費目の実績が /monthly の可処分所得に残る", async () => {
    await addTx(ids, { category: "副業収入", type: "income", amount: 88000, date: "2026-06-09", wallet: "銀行A" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 312000, date: "2026-06-25", wallet: "銀行A" });
    expect(sum(await getMonthlyIncomeRows(M))).toBe(400000);

    const res = await CategoriesPOST(
      new Request("http://test/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "業務委託", pl_type: "income", parent_id: ids.cat["副業収入"] }),
      })
    );
    expect(res.status).toBe(200);

    // 以前は 88,000 が月次の収入セクションから消え、PLサマリ側だけ 400,000 のままだった（バグ）。
    const rows = await getMonthlyIncomeRows(M);
    expect(rows.map((r) => r.name)).toEqual(["給与収入(手取り)", "副業収入", "業務委託"]);
    expect(rows.find((r) => r.name === "副業収入")!.total).toBe(88000);
    expect(rows.find((r) => r.name === "業務委託")!.total).toBe(0);
    expect(sum(rows)).toBe(400000);
    expect((await getPLSummary(M)).disposable).toBe(400000);
    expect(sum(rows)).toBe((await getPLSummary(M)).disposable);
  });
});

// ============================================================
// 3. 費目の無効化と過去月の金額
// ============================================================
describe("費目の無効化（is_active=false）と過去月の金額", () => {
  it("無効化しても、その月に実績がある費目は /monthly に残りサマリと一致する", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 23456, date: "2026-06-10" });
    await addTx(ids, { category: "外食", type: "expense", amount: 8900, date: "2026-06-12" });
    expect(sum(await getVariableLeaves(M))).toBe(32356);

    // 取引があるカテゴリは削除できず「無効化」を案内される（app/api/categories/[id] の DELETE）。
    // つまりこれは推奨された正規の操作。
    const res = await CategoryPUT(
      new Request("http://test/api/categories/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: false }),
      }),
      { params: Promise.resolve({ id: String(ids.cat["外食"]) }) }
    );
    expect(res.status).toBe(200);

    // 以前は無効化した瞬間に 8,900 が /monthly からだけ消え、サマリとの恒久的な不突合になった（バグ）。
    const leaves = await getVariableLeaves(M);
    expect(leaves.map((l) => l.name)).toEqual(["食料品", "外食", "日用品"]);
    expect(leaves.find((l) => l.name === "外食")!.total).toBe(8900);
    expect(sum(leaves)).toBe(32356); // /monthly の変動費合計

    // ロールアップ側・PLサマリと1円まで一致する
    expect((await getVariableGroups(M))[0].total).toBe(32356);
    expect((await getPLSummary(M)).variable).toBe(32356);
    expect((await getVariableGroups(M))[0].total - sum(leaves)).toBe(0);

    // 明細（/transactions・/calendar）にも残るので、画面間で矛盾しない
    expect((await getMonthTransactions(M)).length).toBe(2);

    // 無効化の意味は失われていない：実績が無い月には行として出てこない
    const july = await getVariableLeaves("2026-07-01");
    expect(july.map((l) => l.name)).toEqual(["食料品", "日用品"]);
  });

  it("収入費目を無効化しても、その月の実績は可処分所得から消えない", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-06-25", wallet: "銀行A" });
    await addTx(ids, { category: "副業収入", type: "income", amount: 47000, date: "2026-06-28", wallet: "銀行A" });
    expect(sum(await getMonthlyIncomeRows(M))).toBe(347000);

    await CategoryPUT(
      new Request("http://test/api/categories/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: false }),
      }),
      { params: Promise.resolve({ id: String(ids.cat["副業収入"]) }) }
    );

    // 以前は /monthly の可処分所得だけ 300,000 に減り、/ のサマリは 347,000 のままだった（バグ）。
    const rows = await getMonthlyIncomeRows(M);
    expect(rows.map((r) => r.name)).toEqual(["給与収入(手取り)", "副業収入"]);
    expect(rows.find((r) => r.name === "副業収入")!.total).toBe(47000);
    expect(sum(rows)).toBe(347000);
    expect((await getPLSummary(M)).disposable).toBe(347000);
    expect(sum(rows)).toBe((await getPLSummary(M)).disposable);

    // 実績が無い月では、無効化した費目は収入セクションから消える
    expect((await getMonthlyIncomeRows("2026-07-01")).map((r) => r.name)).toEqual(["給与収入(手取り)"]);
  });

  it("子を無効化しても、親子それぞれの実績は明細に残る（親は入力可には戻らない）", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 4400, date: "2026-06-07" });
    // 子を作る → 親は集計ノード化
    await CategoriesPOST(
      new Request("http://test/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "洗剤", pl_type: "variable_cost", parent_id: ids.cat["日用品"] }),
      })
    );
    const child = (await pool.query(`SELECT id FROM categories WHERE name='洗剤'`)).rows[0].id as number;
    await addTx(ids, { category: "食料品", type: "expense", amount: 1100, date: "2026-06-07" });
    await pool.query(`INSERT INTO transactions (user_id, category_id, type, amount, accrual_date)
                      VALUES ($1,$2,'expense',2200,'2026-06-08')`, [ids.userId, child]);

    // 「やっぱり要らなかった」ので子を無効化する
    const res = await CategoryPUT(
      new Request("http://test/api/categories/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: false }),
      }),
      { params: Promise.resolve({ id: String(child) }) }
    );
    expect(res.status).toBe(200);

    // 以前は「葉＝子を持たない」判定が is_active を見なかったため、無効な子が1件でも残ると
    // 親は永久に葉に戻らず、親 4,400＋子 2,200 がまとめて明細から消えていた（バグ）。
    // 現在は実績のある費目を必ず出すので、親も無効化した子も金額つきで残る。
    const leaves = await getVariableLeaves(M);
    expect(leaves.map((l) => l.name)).toEqual(["食料品", "外食", "日用品", "洗剤"]);
    expect(leaves.find((l) => l.name === "日用品")!.total).toBe(4400);
    expect(leaves.find((l) => l.name === "洗剤")!.total).toBe(2200);

    // 1,100 + 0 + 4,400 + 2,200 = 7,700。ロールアップ・サマリと一致する。
    expect(sum(leaves)).toBe(7700);
    expect((await getVariableGroups(M))[0].total).toBe(7700);
    expect((await getPLSummary(M)).variable).toBe(7700);
    expect(sum(leaves)).toBe((await getPLSummary(M)).variable);

    // 金額は戻ったが、親は is_input_allowed=false のままで入力プルダウンには戻らない。
    // （子を全部消しても親が入力可に復帰しない点は未修正。UIからは自力で戻せない）
    const { rows: c } = await pool.query(
      `SELECT is_input_allowed, is_active FROM categories WHERE id=$1`,
      [ids.cat["日用品"]]
    );
    expect(c[0]).toEqual({ is_input_allowed: false, is_active: true });
  });

  it("無効化しても実績のある費目は /monthly と /analytics の両方に残る（画面間で扱いが揃う）", async () => {
    await addTx(ids, { category: "外食", type: "expense", amount: 8900, date: "2026-06-12" });
    await CategoryPUT(
      new Request("http://test/api/categories/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: false }),
      }),
      { params: Promise.resolve({ id: String(ids.cat["外食"]) }) }
    );

    // 以前は /monthly からだけ消え、is_active を見ない /analytics には残る、という非対称があった（バグ）。
    const leaves = await getVariableLeaves(M);
    const mom = await getCategoryMoM(M);
    expect(leaves.map((l) => l.name)).toContain("外食");
    expect(mom.map((c) => c.name)).toContain("外食");
    // 同じ費目の金額が両画面で一致する
    expect(leaves.find((l) => l.name === "外食")!.total).toBe(8900);
    expect(mom.find((c) => c.name === "外食")!.this_month).toBe(8900);
  });
});

// ============================================================
// 3.5 月次突合：/monthly の4数字 と / のサマリ
// ============================================================
describe("月次突合（/monthly と / が同じ月で同じ数字になるか）", () => {
  /** 固定費マスタ（予実突合の予定源） */
  async function addRule(o: { name: string; category: string; amount: number; start: string }) {
    await pool.query(
      `INSERT INTO recurring_rules (user_id, name, category_id, amount, billing_day, start_month,
                                    billing_cycle, settlement_wallet_id, is_active)
       VALUES ($1,$2,$3,$4,1,$5,'monthly',$6,true)`,
      [ids.userId, o.name, ids.cat[o.category], o.amount, o.start, ids.wallet["銀行A"]]
    );
  }

  it("素直な1ヶ月なら 可処分所得・変動費・黒字 が両画面で一致する", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987, start: "2026-04-01" });
    await addRule({ name: "通信費", category: "通信費", amount: 8800, start: "2026-04-01" });

    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 312345, date: "2026-06-25", wallet: "銀行A" });
    await addTx(ids, { category: "副業収入", type: "income", amount: 48000, date: "2026-06-10", wallet: "銀行A" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 129987, date: "2026-06-01", wallet: "銀行A" });
    await addTx(ids, { category: "通信費", type: "expense", amount: 8800, date: "2026-06-05", wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 42100, date: "2026-06-07", wallet: "現金" });
    await addTx(ids, { category: "外食", type: "expense", amount: 15600, date: "2026-06-14", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 3300, date: "2026-06-21", wallet: "現金" });
    // PL外・控除（どちらの画面のPL数字にも入ってはいけない）
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: "2026-06-25", wallet: "銀行A" });
    await addTx(ids, { category: "投資", type: "expense", amount: 100000, date: "2026-06-26", wallet: "銀行A" });

    // --- /monthly の計算（app/monthly/page.tsx:43-48 と同じ式） ---
    const incomeRows = await getMonthlyIncomeRows(M);
    const leaves = await getVariableLeaves(M);
    const mDisposable = incomeRows.filter((r) => r.pl_type === "income").reduce((s, r) => s + r.total, 0);
    const mVariable = sum(leaves);

    // --- / の計算（app/page.tsx:80 と同じ式） ---
    const pl = await getPLSummary(M);
    const groups = await getVariableGroups(M);

    expect(mDisposable).toBe(360345);
    expect(pl.disposable).toBe(360345);
    expect(mVariable).toBe(61000); // 42,100 + 15,600 + 3,300
    expect(pl.variable).toBe(61000);
    expect(groups.reduce((s, g) => s + g.total, 0)).toBe(61000);
    expect(pl.fixed).toBe(138787); // 129,987 + 8,800
    expect(pl.excluded).toBe(100000);

    // 黒字＝可処分所得 −（固定費＋変動費）。控除・PL対象外は含めない。
    expect(pl.surplus).toBe(360345 - 138787 - 61000);
    expect(pl.surplus).toBe(160558);

    // カレンダー・明細とも突合する
    const daily = await getDailyTotals(M);
    expect(daily.reduce((s, d) => s + d.expense, 0)).toBe(pl.fixed + pl.variable);
    expect(daily.reduce((s, d) => s + d.income, 0)).toBe(pl.disposable);
    expect(await getMonthTransactions(M)).toHaveLength(9);

    // 月次系列（/analytics）も同じ値
    const seriesRow = (await getMonthlySeries(12)).find((s) => s.month === "2026-06");
    expect(seriesRow).toMatchObject({ income: 360345, expense: 199787 });
  });

  it("（現状の記録）マスタに無い固定費の取引は /monthly の固定費合計から落ちる", async () => {
    // 家賃はマスタあり、通信費はマスタなし（一時的な固定費を取引だけで入れたケース）
    await addRule({ name: "家賃", category: "家賃", amount: 129987, start: "2026-04-01" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 129987, date: "2026-06-01", wallet: "銀行A" });
    await addTx(ids, { category: "通信費", type: "expense", amount: 8800, date: "2026-06-05", wallet: "銀行A" });

    const fixedItems = await getFixedCostPlanVsActual(M);
    const mFixed = fixedItems.reduce((s, f) => s + f.effective, 0);
    const pl = await getPLSummary(M);

    // ★これは現状の記録であり、望ましい挙動ではない★
    // /monthly は 129,987、/ のサマリは 138,787。差額 8,800 は画面上どこにも説明が出ない。
    expect(mFixed).toBe(129987);
    expect(pl.fixed).toBe(138787);
    expect(pl.fixed - mFixed).toBe(8800);
    // 明細（/transactions）には出ているので、突合すると必ず迷子になる
    expect((await getMonthTransactions(M)).map((r) => r.category)).toContain("通信費");
  });
});

// ============================================================
// 4. 収入セクション（getMonthlyIncomeRows）
// ============================================================
describe("getMonthlyIncomeRows", () => {
  it("収入の葉だけを、可処分所得と1円まで一致する形で返す", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 312345, date: "2026-06-25", wallet: "銀行A" });
    await addTx(ids, { category: "副業収入", type: "income", amount: 48000, date: "2026-06-10", wallet: "銀行A" });
    // 以下は収入セクションに出てはいけない
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: "2026-06-25" });
    await addTx(ids, { category: "投資", type: "income", amount: 70000, date: "2026-06-26", wallet: "銀行A" });

    const rows = await getMonthlyIncomeRows(M);
    expect(rows.map((r) => [r.name, r.pl_type, r.total])).toEqual([
      ["給与収入(手取り)", "income", 312345],
      ["副業収入", "income", 48000],
    ]);
    expect(sum(rows)).toBe(360345);
    expect((await getPLSummary(M)).disposable).toBe(360345);
  });

  it("PL対象外でも「経費精算」「借入金」だけは収入セクションの末尾に出る（ADR-047）", async () => {
    await addCategory(ids, { name: "経費精算", plType: "excluded", parent: "対象外" });
    await addCategory(ids, { name: "借入金", plType: "excluded", parent: "対象外" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-06-25", wallet: "銀行A" });
    await addTx(ids, { category: "経費精算", type: "income", amount: 12000, date: "2026-06-18", wallet: "銀行A" });
    await addTx(ids, { category: "投資", type: "income", amount: 99999, date: "2026-06-19", wallet: "銀行A" });

    const rows = await getMonthlyIncomeRows(M);
    expect(rows.map((r) => r.name)).toEqual(["給与収入(手取り)", "副業収入", "経費精算", "借入金"]);
    expect(rows.find((r) => r.name === "経費精算")!.total).toBe(12000);
    expect(rows.find((r) => r.name === "借入金")!.total).toBe(0);
    // 「投資」は PL対象外だが名前が対象外なので出ない
    expect(rows.map((r) => r.name)).not.toContain("投資");

    // 可処分所得は income のみ（app/monthly/page.tsx と同じ計算）
    const disposable = rows.filter((r) => r.pl_type === "income").reduce((s, r) => s + r.total, 0);
    expect(disposable).toBe(300000);
    expect((await getPLSummary(M)).disposable).toBe(300000);
  });

  it("収入カテゴリに付いた expense 取引は total に混ざらない（符号の取り違え防止）", async () => {
    await addTx(ids, { category: "副業収入", type: "income", amount: 50000, date: "2026-06-05", wallet: "銀行A" });
    await addTx(ids, { category: "副業収入", type: "expense", amount: 7000, date: "2026-06-06", wallet: "銀行A" });

    const rows = await getMonthlyIncomeRows(M);
    expect(rows.find((r) => r.name === "副業収入")!.total).toBe(50000);
    expect((await getPLSummary(M)).disposable).toBe(50000);
  });

  it("月境界：翌月1日の給与は当月に入らない", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-07-01", wallet: "銀行A" });
    expect(sum(await getMonthlyIncomeRows(M))).toBe(0);
    expect(sum(await getMonthlyIncomeRows("2026-07-01"))).toBe(300000);
  });
});

// ============================================================
// 5. /analytics（getCategoryMoM / getMonthlySeries）
// ============================================================
describe("getCategoryMoM", () => {
  it("当月と前月を同じ費目の行に並べる（前月だけの費目も行が出る）", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 31000, date: "2026-06-03" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 24000, date: "2026-05-03" });
    await addTx(ids, { category: "外食", type: "expense", amount: 12000, date: "2026-06-20" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 5000, date: "2026-05-20" }); // 前月のみ

    const rows = await getCategoryMoM(M);
    expect(rows.map((r) => [r.name, r.this_month, r.last_month])).toEqual([
      ["食料品", 31000, 24000],
      ["外食", 12000, 0],
      ["日用品", 0, 5000],
    ]);
  });

  it("金額の無い費目は行に出ない／income取引は拾わない", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-06-25", wallet: "銀行A" });
    expect(await getCategoryMoM(M)).toEqual([]);
  });

  it("（現状の記録）「支出カテゴリ」に控除・PL対象外が混ざり、本物の変動費を上位から押し出す", async () => {
    // /analytics の見出しは「支出カテゴリ 今月トップ（前月比）」。
    // クエリに pl_type の絞り込みが無いため 投資(PL対象外)・社会保険料(控除) も支出として並ぶ。
    await addTx(ids, { category: "投資", type: "expense", amount: 200000, date: "2026-06-25" });
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: "2026-06-25" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 31000, date: "2026-06-03" });

    const rows = await getCategoryMoM(M);
    // ★これは現状の記録であり、望ましい挙動ではない★
    expect(rows.map((r) => [r.name, r.pl_type])).toEqual([
      ["投資", "excluded"],
      ["社会保険料", "deduction"],
      ["食料品", "variable_cost"],
    ]);
  });

  it("（現状の記録）is_input_allowed=false の集計ノードに付いた金額は /analytics から丸ごと落ちる", async () => {
    await addTx(ids, { category: "食費", type: "expense", amount: 60000, date: "2026-06-04" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: "2026-06-05" });

    const rows = await getCategoryMoM(M);
    // ★現状の記録★ 60,000 はどの行にも現れない（groups では拾われている）
    expect(rows.map((r) => [r.name, r.this_month])).toEqual([["食料品", 1000]]);
    expect((await getVariableGroups(M))[0].total).toBe(61000);
  });

  it("上位8件に絞られる（9件目以降は落ちる）", async () => {
    const extra = ["交際費", "被服費", "医療費", "交通費"];
    for (const n of extra) await addCategory(ids, { name: n, plType: "variable_cost", parent: "変動費" });
    const names = ["食料品", "外食", "日用品", "家賃", "通信費", "年額サブスク", "社会保険料", "投資", ...extra];
    // 金額を降順に振る（90,000 / 89,000 / ...）ことで順位を確定させる
    let amt = 90000;
    for (const n of names) {
      await addTx(ids, { category: n, type: "expense", amount: amt, date: "2026-06-14" });
      amt -= 1000;
    }
    const rows = await getCategoryMoM(M);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.name)).toEqual(names.slice(0, 8));
    expect(rows[0].this_month).toBe(90000);
  });
});

describe("年またぎの月境界", () => {
  it("12月/1月をまたいでも各集計が隣月に漏れない", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 11000, date: "2025-12-31", wallet: "現金" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 22000, date: "2026-01-01", wallet: "現金" });
    await addTx(ids, { category: "外食", type: "expense", amount: 33000, date: "2026-01-31", wallet: "現金" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 44000, date: "2026-02-01", wallet: "現金" });

    expect((await getVariableGroups("2026-01-01"))[0].total).toBe(55000);
    expect(sum(await getVariableLeaves("2026-01-01"))).toBe(55000);
    expect((await getPLSummary("2026-01-01")).variable).toBe(55000);
    expect((await getDailyTotals("2026-01-01")).map((d) => d.date)).toEqual(["2026-01-01", "2026-01-31"]);
    expect(await getMonthTransactions("2026-01-01")).toHaveLength(2);
    expect((await getVariableGroups("2025-12-01"))[0].total).toBe(11000);

    // MoM の「前月」は 2025-12（年をまたいで正しく引ける）
    const mom = await getCategoryMoM("2026-01-01");
    expect(mom.map((c) => [c.name, c.this_month, c.last_month])).toEqual([
      ["外食", 33000, 0],
      ["食料品", 22000, 11000],
    ]);
  });

  it("日境界：getDayTransactions は年末年始でも指定日だけを返す", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 11000, date: "2025-12-31", wallet: "現金" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 22000, date: "2026-01-01", wallet: "現金" });
    const rows = await getDayTransactions("2026-01-01");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(22000);
  });
});

describe("getMonthlySeries", () => {
  /** DBの CURRENT_DATE から 'YYYY-MM' のラベル列を作る（実行日に依存させない） */
  async function monthKeys(n: number): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT to_char(g,'YYYY-MM') AS k FROM generate_series(
         date_trunc('month', CURRENT_DATE) - (($1::int - 1) * interval '1 month'),
         date_trunc('month', CURRENT_DATE), interval '1 month') g ORDER BY g`,
      [n]
    );
    return rows.map((r) => r.k as string);
  }
  /** 'YYYY-MM' → 'YYYY-MM-01' */
  const p = (k: string) => `${k}-01`;

  it("取引が無い月も 0 埋めで n ヶ月きっちり返る", async () => {
    const keys = await monthKeys(6);
    const series = await getMonthlySeries(6);
    expect(series.map((s) => s.month)).toEqual(keys);
    expect(series.every((s) => s.income === 0 && s.expense === 0 && s.surplus === 0)).toBe(true);
  });

  it("月ごとの収入・支出・黒字が getPLSummary と一致する", async () => {
    const keys = await monthKeys(3); // [2ヶ月前, 先月, 当月]
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: `${keys[1]}-25`, wallet: "銀行A" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 130000, date: `${keys[1]}-01`, wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 42000, date: `${keys[1]}-15`, wallet: "現金" });
    // PL外は支出に含めない
    await addTx(ids, { category: "投資", type: "expense", amount: 500000, date: `${keys[1]}-26`, wallet: "銀行A" });
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: `${keys[1]}-25`, wallet: "銀行A" });

    const series = await getMonthlySeries(3);
    expect(series).toHaveLength(3);
    const last = series[1];
    expect(last.month).toBe(keys[1]);
    expect(last.income).toBe(300000);
    expect(last.expense).toBe(172000); // 130,000 + 42,000
    expect(last.surplus).toBe(128000);

    const pl = await getPLSummary(p(keys[1]));
    expect(last.income).toBe(pl.disposable);
    expect(last.expense).toBe(pl.fixed + pl.variable);

    expect(series[0]).toMatchObject({ month: keys[0], income: 0, expense: 0, surplus: 0 });
    expect(series[2]).toMatchObject({ month: keys[2], income: 0, expense: 0, surplus: 0 });
  });

  it("ウィンドウ外（過去すぎる月・未来月）は出ない", async () => {
    const keys = await monthKeys(3);
    const older = (await monthKeys(4))[0]; // ウィンドウの1つ前
    await addTx(ids, { category: "食料品", type: "expense", amount: 11111, date: `${older}-10` });
    await addTx(ids, { category: "食料品", type: "expense", amount: 22222, date: "2027-12-10" }); // 未来

    const series = await getMonthlySeries(3);
    expect(series.map((s) => s.month)).toEqual(keys);
    expect(series.reduce((s, x) => s + x.expense, 0)).toBe(0);
  });
});

// ============================================================
// 6. /calendar（getDailyTotals / getDayTransactions）
// ============================================================
describe("getDailyTotals / getDayTransactions", () => {
  it("日ごとの合計が正しく、月で合算すると getPLSummary と一致する", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: "2026-06-03", wallet: "現金" });
    await addTx(ids, { category: "外食", type: "expense", amount: 2500, date: "2026-06-03", wallet: "クレカA" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 130000, date: "2026-06-01", wallet: "銀行A" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-06-25", wallet: "銀行A" });

    const daily = await getDailyTotals(M);
    expect(daily).toEqual([
      { date: "2026-06-01", expense: 130000, income: 0 },
      { date: "2026-06-03", expense: 3500, income: 0 },
      { date: "2026-06-25", expense: 0, income: 300000 },
    ]);

    const pl = await getPLSummary(M);
    expect(daily.reduce((s, d) => s + d.expense, 0)).toBe(pl.fixed + pl.variable);
    expect(daily.reduce((s, d) => s + d.income, 0)).toBe(pl.disposable);
  });

  it("取引のある日だけ行が返る（0埋めしない）", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 500, date: "2026-06-15" });
    const daily = await getDailyTotals(M);
    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe("2026-06-15");
  });

  it("getDayTransactions は指定日だけを返し、無い日は空配列", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1200, date: "2026-06-14", wallet: "現金", memo: "前日" });
    await addTx(ids, { category: "外食", type: "expense", amount: 3400, date: "2026-06-15", wallet: "クレカA", memo: "当日" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 5600, date: "2026-06-16", wallet: "現金", memo: "翌日" });

    const rows = await getDayTransactions("2026-06-15");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-06-15",
      category: "外食",
      pl_type: "variable_cost",
      type: "expense",
      amount: 3400,
      memo: "当日",
      wallets: "クレカA",
    });
    expect(await getDayTransactions("2026-06-17")).toEqual([]);
  });

  it("（現状の記録）カレンダーのセル金額と、その日の明細合計が食い違う", async () => {
    // セル = getDailyTotals（固定費+変動費のみ）
    // 明細 = getDayTransactions（PL対象外・控除も含む全件）。app/calendar/page.tsx:63 が明細から合計を出す。
    await addTx(ids, { category: "食料品", type: "expense", amount: 3000, date: "2026-06-20", wallet: "現金" });
    await addTx(ids, { category: "投資", type: "expense", amount: 100000, date: "2026-06-20", wallet: "銀行A" });
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: "2026-06-20", wallet: "銀行A" });

    const cell = (await getDailyTotals(M)).find((d) => d.date === "2026-06-20")!;
    const rows = await getDayTransactions("2026-06-20");
    const dayExpense = rows.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

    // ★これは現状の記録であり、望ましい挙動ではない★
    // 同じ画面の同じ日で「−¥3,000」と「支出 ¥148,000」が並ぶ。
    expect(cell.expense).toBe(3000);
    expect(dayExpense).toBe(148000);
    expect(rows).toHaveLength(3);
  });

  it("（現状の記録）PL対象外しか無い日は、金額0の行が返る", async () => {
    await addTx(ids, { category: "投資", type: "expense", amount: 100000, date: "2026-06-22", wallet: "銀行A" });
    const daily = await getDailyTotals(M);
    // 行は返るが expense=0（画面側が `t.expense > 0` で判定しているので表示は出ない）
    expect(daily).toEqual([{ date: "2026-06-22", expense: 0, income: 0 }]);
  });
});

// ============================================================
// 7. /transactions（getMonthTransactions のフィルタ）
// ============================================================
describe("getMonthTransactions のフィルタ", () => {
  async function seedMixed() {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: "2026-06-05", wallet: "現金" });
    await addTx(ids, { category: "外食", type: "expense", amount: 2000, date: "2026-06-10", wallet: "クレカA" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 130000, date: "2026-06-01", wallet: "銀行A" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-06-25", wallet: "銀行A" });
    await addTx(ids, { category: "投資", type: "expense", amount: 50000, date: "2026-06-26", wallet: "銀行A" });
  }

  it("フィルタ無しは当月全件を発生日の新しい順で返す（PL対象外も含む）", async () => {
    await seedMixed();
    const rows = await getMonthTransactions(M);
    expect(rows.map((r) => r.date)).toEqual([
      "2026-06-26",
      "2026-06-25",
      "2026-06-10",
      "2026-06-05",
      "2026-06-01",
    ]);
    expect(rows).toHaveLength(5);
  });

  it("同一日の複数件は id の降順（新しい順）", async () => {
    const a = await addTx(ids, { category: "食料品", type: "expense", amount: 100, date: "2026-06-05" });
    const b = await addTx(ids, { category: "外食", type: "expense", amount: 200, date: "2026-06-05" });
    const rows = await getMonthTransactions(M);
    expect(rows.map((r) => r.id)).toEqual([b, a]);
  });

  it("種別フィルタ", async () => {
    await seedMixed();
    const inc = await getMonthTransactions(M, { type: "income" });
    expect(inc).toHaveLength(1);
    expect(inc[0].amount).toBe(300000);

    const exp = await getMonthTransactions(M, { type: "expense" });
    expect(exp).toHaveLength(4);
    expect(exp.reduce((s, r) => s + r.amount, 0)).toBe(183000);
  });

  it("カテゴリフィルタは完全一致（親カテゴリでは配下を拾わない）", async () => {
    await seedMixed();
    const only = await getMonthTransactions(M, { categoryId: ids.cat["食料品"] });
    expect(only).toHaveLength(1);
    expect(only[0].category).toBe("食料品");

    // 親（食費）で絞っても配下の 食料品/外食 は出ない。
    // 画面のプルダウンは入力可カテゴリしか出さないため通常は到達しないが、仕様として固定しておく。
    expect(await getMonthTransactions(M, { categoryId: ids.cat["食費"] })).toEqual([]);
  });

  it("決済手段フィルタ＋種別フィルタは AND で効く", async () => {
    await seedMixed();
    const bank = await getMonthTransactions(M, { walletId: ids.wallet["銀行A"] });
    expect(bank).toHaveLength(3); // 家賃 / 給与 / 投資

    const bankExpense = await getMonthTransactions(M, { walletId: ids.wallet["銀行A"], type: "expense" });
    expect(bankExpense).toHaveLength(2);
    expect(bankExpense.map((r) => r.category)).toEqual(["投資", "家賃"]); // 発生日の新しい順

    const card = await getMonthTransactions(M, { walletId: ids.wallet["クレカA"] });
    expect(card).toHaveLength(1);
    expect(card[0].category).toBe("外食");
  });

  it("脚が無い取引は wallets が null（行自体は消えない）", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1500, date: "2026-06-08" }); // wallet 指定なし
    const rows = await getMonthTransactions(M);
    expect(rows).toHaveLength(1);
    expect(rows[0].wallets).toBeNull();
    // ウォレット絞り込みでは当然ヒットしない
    expect(await getMonthTransactions(M, { walletId: ids.wallet["現金"] })).toEqual([]);
  });

  it("分割払いは1行にまとまり、ウォレット名が ' + ' 連結される（行の重複なし）", async () => {
    await addSplitTx(ids, {
      category: "食料品",
      type: "expense",
      date: "2026-06-09",
      legs: [["銀行A", 6000], ["現金", 4000]],
    });
    const all = await getMonthTransactions(M);
    expect(all).toHaveLength(1);
    expect(all[0].amount).toBe(10000);
    expect(all[0].wallets).toBe("銀行A + 現金");

    // どちらのウォレットで絞っても同じ1行が返る
    expect(await getMonthTransactions(M, { walletId: ids.wallet["現金"] })).toHaveLength(1);
    expect(await getMonthTransactions(M, { walletId: ids.wallet["銀行A"] })).toHaveLength(1);
  });

  it("（現状の記録）決済手段で絞った合計が、その手段で払った額ではなく取引総額になる", async () => {
    // app/transactions/page.tsx:63 の filteredTotal は行の amount を足す。
    // 銀行A 6,000 / 現金 4,000 の分割払いを「現金」で絞ると、合計は 4,000 ではなく 10,000 になる。
    await addSplitTx(ids, {
      category: "食料品",
      type: "expense",
      date: "2026-06-09",
      legs: [["銀行A", 6000], ["現金", 4000]],
    });
    const rows = await getMonthTransactions(M, { walletId: ids.wallet["現金"] });
    const filteredTotal = rows.reduce((s, t) => s + (t.type === "income" ? t.amount : -t.amount), 0);
    // ★これは現状の記録であり、望ましい挙動ではない★
    expect(filteredTotal).toBe(-10000);
  });

  it("月境界：翌月の取引はフィルタ有無にかかわらず出ない", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 999, date: "2026-07-01", wallet: "現金" });
    expect(await getMonthTransactions(M)).toEqual([]);
    expect(await getMonthTransactions(M, { walletId: ids.wallet["現金"] })).toEqual([]);
    expect(await getMonthTransactions("2026-07-01")).toHaveLength(1);
  });
});
