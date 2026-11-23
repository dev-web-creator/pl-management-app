// 年度集計・予算・週次。スプレッドシートとの「年間突合」「週次突合」に直結する層。
//
// ここで守りたい事実:
//   1) FY境界(既定4月)が1日もズレないこと（3/31と4/1）
//   2) 年度の12ヶ月が1行も欠けないこと（取引が無い月も0行が出る）
//   3) 明細(getFiscalYearPL)の合計 == サマリ(getFiscalYearTotal) であること
//   4) 予算未設定でも 0除算/null/NaN が出ないこと
//   5) 週の切り方（月曜始まり・月またぎ）と、週次⇔月次の金額が一致すること
//
// 週次は CURRENT_DATE 依存のため、日付は「今週の月曜」を起点に実行時に組み立てる。
// 金額はすべてハードコードの実数で突合する。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import {
  getFiscalYearPL,
  getFiscalYearTotal,
  getFyTargets,
  getUserFyStartMonth,
  getBudgetVsActual,
  getWeeklyProgress,
  getAssetTarget,
  getPLSummary,
  getAssets,
} from "@/lib/queries";
import { POST as postTargets } from "@/app/api/targets/route";
import { PUT as putSettings } from "@/app/api/settings/route";

let ids: Ids;

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

// ---- 小道具 -------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const parseIso = (s: string) => new Date(s + "T00:00:00");
const monthPeriodOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;

/** app/weekly/page.tsx:19-21 と同じ「今週の月曜」 */
function thisMonday(): Date {
  const now = new Date();
  const m = new Date(now);
  m.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  m.setHours(0, 0, 0, 0);
  return m;
}
const MON = thisMonday();
/** k週前の月曜（k=0 が今週） */
const weekMon = (k: number) => addDays(MON, -7 * k);

/** app/budget/page.tsx:20 の達成率。target<=0 のとき null（0除算しない設計） */
const pct = (actual: number, target: number) => (target > 0 ? Math.round((actual / target) * 100) : null);

async function addTarget(period: string, metric: string, amount: number) {
  await pool.query(
    `INSERT INTO targets (user_id, period, metric, amount) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, period, metric) DO UPDATE SET amount=EXCLUDED.amount`,
    [ids.userId, period, metric, amount]
  );
}

async function closeSection(period: string, section: string, closed = true) {
  await pool.query(
    `INSERT INTO monthly_closings (user_id, period, section, is_closed) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, period, section) DO UPDATE SET is_closed=EXCLUDED.is_closed`,
    [ids.userId, period, section, closed]
  );
}

/** 変動費のルートグループをもう1つ作る（週次のロールアップ列を2本にするため） */
async function addVariableRoot(name: string, order: number) {
  const r = await pool.query(
    `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
     VALUES ($1,NULL,$2,'variable_cost',true,$3) RETURNING id`,
    [ids.userId, name, order]
  );
  ids.cat[name] = r.rows[0].id;
}

const targetsReq = (b: unknown) =>
  postTargets(
    new Request("http://localhost/api/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })
  );

const settingsReq = (b: unknown) =>
  putSettings(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })
  );

// =========================================================================
// 1. FY境界（ADR-007 / ADR-017）
// =========================================================================
describe("FY境界（既定4月開始）", () => {
  it("2026-03-31 はFY2026に入らず、2026-04-01 から入る（1日の取り違えが無い）", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-03-31" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 400000, date: "2026-04-01" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 500000, date: "2027-03-31" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 600000, date: "2027-04-01" });

    const fy2026 = await getFiscalYearPL("2026-04-01");
    expect(fy2026[0].month).toBe("2026-04");
    expect(fy2026[0].income).toBe(400000);
    expect(fy2026[11].month).toBe("2027-03");
    expect(fy2026[11].income).toBe(500000);
    // 前後の年度に属する2件は混ざらない
    expect(fy2026.reduce((a, r) => a + r.income, 0)).toBe(900000);

    // 3/31 は前年度(FY2025)の最終月、4/1(翌年) は次年度(FY2027)の初月
    const fy2025 = await getFiscalYearPL("2025-04-01");
    expect(fy2025[11].month).toBe("2026-03");
    expect(fy2025[11].income).toBe(300000);
    const fy2027 = await getFiscalYearPL("2027-04-01");
    expect(fy2027[0].month).toBe("2027-04");
    expect(fy2027[0].income).toBe(600000);
  });

  it("取引が1件も無くても12ヶ月が欠けずに0で並ぶ", async () => {
    const rows = await getFiscalYearPL("2026-04-01");
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.month)).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
      "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03",
    ]);
    for (const r of rows) {
      expect(r.income).toBe(0);
      expect(r.fixed).toBe(0);
      expect(r.variable).toBe(0);
      expect(r.surplus).toBe(0);
    }
    const tot = await getFiscalYearTotal("2026-04-01");
    expect(tot).toEqual({ income: 0, fixed: 0, variable: 0, surplus: 0 });
  });

  it("飛び飛びの月に取引があっても、間の月は0行として残る", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 8000, date: "2026-04-12" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 9000, date: "2026-09-12" });

    const rows = await getFiscalYearPL("2026-04-01");
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.variable)).toEqual([8000, 0, 0, 0, 0, 9000, 0, 0, 0, 0, 0, 0]);
  });

  it("1月開始のFYでも12ヶ月が 2026-01〜2026-12 で並ぶ", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1234, date: "2026-12-31" });
    const rows = await getFiscalYearPL("2026-01-01");
    expect(rows.map((r) => r.month)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
    expect(rows[11].variable).toBe(1234);
  });
});

// =========================================================================
// 2. 内部整合: 明細の合計 == サマリ
// =========================================================================
describe("getFiscalYearPL と getFiscalYearTotal の内部整合", () => {
  // /year は「月次テーブル＝PL」「FY比較バー＝Total」で別クエリを使う。
  // ここがズレると画面上で年計が2つ出て食い違う。
  async function seedFyData() {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 320000, date: "2026-04-25" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 129000, date: "2026-04-10" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 8000, date: "2026-04-12" });
    await addTx(ids, { category: "外食", type: "expense", amount: 3500, date: "2026-05-03" });
    await addTx(ids, { category: "通信費", type: "expense", amount: 4400, date: "2026-07-01" });
    await addTx(ids, { category: "副業収入", type: "income", amount: 55000, date: "2026-11-20" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 1200, date: "2027-02-14" });
    // PL非計上（控除・対象外）: どちらにも入ってはいけない
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: "2026-06-25" });
    await addTx(ids, { category: "投資", type: "expense", amount: 100000, date: "2026-06-26" });
  }

  it("12ヶ月の合計が Total の各項目と1円単位で一致する", async () => {
    await seedFyData();
    const rows = await getFiscalYearPL("2026-04-01");
    const tot = await getFiscalYearTotal("2026-04-01");

    const sum = rows.reduce(
      (a, r) => ({
        income: a.income + r.income,
        fixed: a.fixed + r.fixed,
        variable: a.variable + r.variable,
        surplus: a.surplus + r.surplus,
      }),
      { income: 0, fixed: 0, variable: 0, surplus: 0 }
    );

    // 手計算: 収入 320000+55000 / 固定 129000+4400 / 変動 8000+3500+1200
    expect(sum).toEqual({ income: 375000, fixed: 133400, variable: 12700, surplus: 228900 });
    expect(tot).toEqual(sum);
  });

  it("各月の surplus = income - fixed - variable", async () => {
    await seedFyData();
    const rows = await getFiscalYearPL("2026-04-01");
    for (const r of rows) {
      expect(r.surplus).toBe(r.income - r.fixed - r.variable);
    }
    // 2026-04: 320000 - 129000 - 8000
    expect(rows[0]).toEqual({ month: "2026-04", income: 320000, fixed: 129000, variable: 8000, surplus: 183000 });
  });

  it("deduction(社会保険料) と excluded(投資) は年度PLにも年計にも入らない", async () => {
    await seedFyData();
    const rows = await getFiscalYearPL("2026-04-01");
    const jun = rows.find((r) => r.month === "2026-06")!;
    // 6月には 45,000(控除) と 100,000(対象外) しか無い → PL上は全部0
    expect(jun).toEqual({ month: "2026-06", income: 0, fixed: 0, variable: 0, surplus: 0 });
    const tot = await getFiscalYearTotal("2026-04-01");
    expect(tot.fixed + tot.variable).toBe(146100); // 145,000 は含まれない
  });

  it("【現状の記録 / 不具合】startPeriod が月初でないと PL は全0なのに Total だけ数字が出る", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // getFiscalYearPL は generate_series($2, +11months) の日付そのものと
    // date_trunc('month', accrual_date) を突き合わせるため、$2 が月初でないと
    // 永遠に一致せず全月0になる。getFiscalYearTotal は範囲比較なので数字が出る。
    // /year 側の ?start は /^\d{4}-\d{2}-01$/ で弾いているため現時点では画面に出ないが、
    // 「明細の合計 == サマリ」という不変条件はこの入力で破れている。
    await seedFyData();
    const rows = await getFiscalYearPL("2026-04-15");
    const tot = await getFiscalYearTotal("2026-04-15");

    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.income === 0 && r.fixed === 0 && r.variable === 0)).toBe(true);
    // ラベルだけは 2026-04 … 2027-03 と正しく見えてしまう
    expect(rows[0].month).toBe("2026-04");

    // 一方サマリは 2026-04-15 〜 2027-04-14 の実数を返す
    expect(tot).toEqual({ income: 375000, fixed: 4400, variable: 4700, surplus: 365900 });
    expect(rows.reduce((a, r) => a + r.income, 0)).not.toBe(tot.income);
  });
});

// =========================================================================
// 3. FY開始月の設定（ADR-017）
// =========================================================================
describe("FY開始月の設定", () => {
  it("既定は4月", async () => {
    expect(await getUserFyStartMonth()).toBe(4);
  });

  it("PUT /api/settings で変更でき、1〜12以外は400で拒否して値を変えない", async () => {
    expect((await settingsReq({ fiscal_year_start_month: 1 })).status).toBe(200);
    expect(await getUserFyStartMonth()).toBe(1);

    for (const bad of [0, 13, 4.5, -1, "abc"]) {
      const res = await settingsReq({ fiscal_year_start_month: bad });
      expect(res.status).toBe(400);
    }
    expect(await getUserFyStartMonth()).toBe(1); // 拒否後も1のまま
  });

  it("FY開始月を変えると、同じ取引が別の年度に属する（過去の年計が変わる）", async () => {
    // 2026-02-15 の変動費 9,800 は…
    await addTx(ids, { category: "食料品", type: "expense", amount: 9800, date: "2026-02-15" });
    // 参考として 2026-05-10 にも1件
    await addTx(ids, { category: "食料品", type: "expense", amount: 500, date: "2026-05-10" });

    // 4月開始のとき: 2026-02 は FY2025(2025-04〜2026-03) 側
    const apr2025 = await getFiscalYearTotal("2025-04-01");
    const apr2026 = await getFiscalYearTotal("2026-04-01");
    expect(apr2025.variable).toBe(9800);
    expect(apr2026.variable).toBe(500);

    // 1月開始に変更すると「FY2026」というラベルが指す窓が 2026-01〜2026-12 に変わり、
    // 同じ 9,800 が FY2026 側に移る。過去データは書き換わらないが、年計の見え方は変わる。
    expect((await settingsReq({ fiscal_year_start_month: 1 })).status).toBe(200);
    expect(await getUserFyStartMonth()).toBe(1);
    const jan2026 = await getFiscalYearTotal("2026-01-01");
    expect(jan2026.variable).toBe(10300); // 9800 + 500
    const jan2025 = await getFiscalYearTotal("2025-01-01");
    expect(jan2025.variable).toBe(0);
  });

  it("getFiscalYearPL/Total は FY開始月の設定を参照せず、引数の startPeriod だけで決まる", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 7777, date: "2026-02-15" });
    const before = await getFiscalYearTotal("2026-04-01");
    await settingsReq({ fiscal_year_start_month: 2 });
    const after = await getFiscalYearTotal("2026-04-01");
    expect(after).toEqual(before); // 設定変更だけでは同じ引数の結果は変わらない
    expect(after.variable).toBe(0);
  });
});

// =========================================================================
// 4. 予算・目標（ADR-016 / 018 / 020）
// =========================================================================
describe("予算（targets）", () => {
  it("予算未設定でも 0除算・null・NaN が出ない", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-05-20" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 120000, date: "2026-05-01" });
    await addTx(ids, { category: "外食", type: "expense", amount: 6500, date: "2026-05-11" });

    const b = await getBudgetVsActual("2026-05-01");
    expect(b).toEqual({
      target_income: 0,
      target_expense: 0,
      target_total_assets: 0,
      actual_income: 300000,
      actual_expense: 126500,
      closed: false,
    });
    for (const v of Object.values(b)) {
      expect(v).not.toBeNull();
      if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    }
    // 画面の達成率式は Infinity/NaN ではなく null になる
    expect(pct(b.actual_income, b.target_income)).toBeNull();
    expect(pct(b.actual_expense, b.target_expense)).toBeNull();
    // 総資産目標も 0（null ではない）
    const at = await getAssetTarget("2026-05-01");
    expect(at).toBe(0);
    expect(typeof at).toBe("number");
  });

  it("取引も予算も無い月は全部0で返る", async () => {
    const b = await getBudgetVsActual("2030-01-01");
    expect(b).toEqual({
      target_income: 0,
      target_expense: 0,
      target_total_assets: 0,
      actual_income: 0,
      actual_expense: 0,
      closed: false,
    });
  });

  it("POST /api/targets は income/expense/net_balance/total_assets を保存する", async () => {
    const res = await targetsReq({ period: "2026-05-01", income: 400000, expense: 250000, total_assets: 5000000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { rows } = await pool.query(
      `SELECT metric, amount FROM targets WHERE user_id=$1 AND period='2026-05-01' ORDER BY metric`,
      [ids.userId]
    );
    expect(rows).toEqual([
      { metric: "expense", amount: 250000 },
      { metric: "income", amount: 400000 },
      { metric: "net_balance", amount: 150000 }, // 自動算出
      { metric: "total_assets", amount: 5000000 },
    ]);

    const b = await getBudgetVsActual("2026-05-01");
    expect(b.target_income).toBe(400000);
    expect(b.target_expense).toBe(250000);
    expect(b.target_total_assets).toBe(5000000);
    // getAssetTarget と getBudgetVsActual が同じ数字を返す（クロス検証）
    expect(await getAssetTarget("2026-05-01")).toBe(b.target_total_assets);
  });

  it("period が YYYY-MM-01 でなければ400で保存しない", async () => {
    for (const p of ["2026-05-15", "2026-5-01", "", undefined, "abc"]) {
      const res = await targetsReq({ period: p, income: 1, expense: 1 });
      expect(res.status).toBe(400);
    }
    const { rows } = await pool.query(`SELECT count(*)::int n FROM targets WHERE user_id=$1`, [ids.userId]);
    expect(rows[0].n).toBe(0);
  });

  it("【現状の記録 / 不具合】total_assets だけ送ると income/expense が黙って0に上書きされる", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // app/api/targets/route.ts は income/expense/net_balance を常に entries に積み、
    // 未指定なら Number(undefined)||0 = 0 として UPSERT する（部分更新ができない）。
    await targetsReq({ period: "2026-05-01", income: 400000, expense: 250000 });
    expect((await getBudgetVsActual("2026-05-01")).target_income).toBe(400000);

    // 総資産目標だけ更新したつもりのリクエスト
    const res = await targetsReq({ period: "2026-05-01", total_assets: 5000000 });
    expect(res.status).toBe(200);

    const b = await getBudgetVsActual("2026-05-01");
    expect(b.target_total_assets).toBe(5000000);
    expect(b.target_income).toBe(0); // ← 400,000 が消えている
    expect(b.target_expense).toBe(0); // ← 250,000 が消えている
    const { rows } = await pool.query(
      `SELECT amount FROM targets WHERE user_id=$1 AND period='2026-05-01' AND metric='net_balance'`,
      [ids.userId]
    );
    expect(rows[0].amount).toBe(0);
  });

  it("【現状の記録 / 不具合】数字にできない値は400ではなく0として保存される", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // Number("1,200,000") は NaN → `|| 0` で 0。桁区切り付きの値をAPIに投げると
    // エラーにならず予算が0になる（画面は数字のみ入力に制限しているので現状UIからは踏めない）。
    const res = await targetsReq({ period: "2026-06-01", income: "1,200,000", expense: "abc" });
    expect(res.status).toBe(200);
    const b = await getBudgetVsActual("2026-06-01");
    expect(b.target_income).toBe(0);
    expect(b.target_expense).toBe(0);
  });

  it("closed は income/fixed_cost/variable_cost の3セクションが揃って初めて true", async () => {
    await closeSection("2026-05-01", "income");
    await closeSection("2026-05-01", "fixed_cost");
    expect((await getBudgetVsActual("2026-05-01")).closed).toBe(false);

    // 'assets' は数に入らない
    await closeSection("2026-05-01", "assets");
    expect((await getBudgetVsActual("2026-05-01")).closed).toBe(false);

    await closeSection("2026-05-01", "variable_cost");
    expect((await getBudgetVsActual("2026-05-01")).closed).toBe(true);

    // 1つでも解除すれば false に戻る
    await closeSection("2026-05-01", "income", false);
    expect((await getBudgetVsActual("2026-05-01")).closed).toBe(false);
  });
});

describe("getFyTargets（年間予実の予算行）", () => {
  it("12ヶ月分が並び、未設定月は0、年度外の目標は混ざらない", async () => {
    await addTarget("2026-04-01", "income", 400000);
    await addTarget("2026-04-01", "expense", 250000);
    await addTarget("2026-12-01", "income", 800000);
    await addTarget("2027-03-01", "expense", 300000);
    // 年度外（前月・翌月）
    await addTarget("2026-03-01", "income", 999999);
    await addTarget("2027-04-01", "expense", 888888);
    // 対象外の metric
    await addTarget("2026-04-01", "net_balance", 150000);
    await addTarget("2026-04-01", "total_assets", 5000000);

    const rows = await getFyTargets("2026-04-01");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ month: "2026-04", income: 400000, expense: 250000 });
    expect(rows[8]).toEqual({ month: "2026-12", income: 800000, expense: 0 });
    expect(rows[11]).toEqual({ month: "2027-03", income: 0, expense: 300000 });
    // 未設定月
    expect(rows[1]).toEqual({ month: "2026-05", income: 0, expense: 0 });
    // 年度外は入らない
    expect(rows.reduce((a, r) => a + r.income, 0)).toBe(1200000);
    expect(rows.reduce((a, r) => a + r.expense, 0)).toBe(550000);
  });

  it("getFyTargets の各月 == getBudgetVsActual の各月（クロス検証）", async () => {
    await addTarget("2026-04-01", "income", 400000);
    await addTarget("2026-04-01", "expense", 250000);
    await addTarget("2026-09-01", "income", 123456);
    await addTarget("2026-09-01", "expense", 78900);

    const rows = await getFyTargets("2026-04-01");
    for (const r of rows) {
      const b = await getBudgetVsActual(`${r.month}-01`);
      expect({ income: b.target_income, expense: b.target_expense }).toEqual({
        income: r.income,
        expense: r.expense,
      });
    }
  });

  it("予算の年計 vs 実績の年計が /year の達成率式で計算できる", async () => {
    await addTarget("2026-04-01", "income", 300000);
    await addTarget("2026-04-01", "expense", 200000);
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 240000, date: "2026-04-25" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 120000, date: "2026-04-01" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-04-10" });

    const targets = await getFyTargets("2026-04-01");
    const rows = await getFiscalYearPL("2026-04-01");
    const tgTot = targets.reduce((a, t) => ({ income: a.income + t.income, expense: a.expense + t.expense }), {
      income: 0,
      expense: 0,
    });
    const tot = rows.reduce(
      (a, r) => ({ income: a.income + r.income, expense: a.expense + r.fixed + r.variable }),
      { income: 0, expense: 0 }
    );
    expect(tgTot).toEqual({ income: 300000, expense: 200000 });
    expect(tot).toEqual({ income: 240000, expense: 150000 });
    expect(Math.round((tot.income / tgTot.income) * 100)).toBe(80);
    expect(Math.round((tot.expense / tgTot.expense) * 100)).toBe(75);
  });
});

// =========================================================================
// 5. 週次進捗（ADR-036）
// =========================================================================
describe("週次進捗（月曜始まり）", () => {
  it("月曜〜日曜が1行になり、前週とは別行になる", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: isoOf(weekMon(0)) });
    await addTx(ids, { category: "外食", type: "expense", amount: 2000, date: isoOf(addDays(weekMon(0), 6)) });
    await addTx(ids, { category: "日用品", type: "expense", amount: 300, date: isoOf(addDays(weekMon(0), -1)) });

    const { rows } = await getWeeklyProgress(12);
    expect(rows).toHaveLength(2);
    // 新しい週が先頭
    expect(rows[0].week_start).toBe(isoOf(weekMon(0)));
    expect(rows[0].week_end).toBe(isoOf(addDays(weekMon(0), 6)));
    expect(rows[0].total).toBe(3000);
    // 日曜(前週の最終日)は前の週に入る
    expect(rows[1].week_start).toBe(isoOf(weekMon(1)));
    expect(rows[1].week_end).toBe(isoOf(addDays(weekMon(1), 6)));
    expect(rows[1].total).toBe(300);
  });

  it("変動費以外（固定費・収入・控除・対象外）は週次に入らない", async () => {
    const d = isoOf(weekMon(1));
    await addTx(ids, { category: "食料品", type: "expense", amount: 1500, date: d });
    await addTx(ids, { category: "家賃", type: "expense", amount: 120000, date: d });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: d });
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: d });
    await addTx(ids, { category: "投資", type: "expense", amount: 100000, date: d });

    const { rows } = await getWeeklyProgress(12);
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(1500);
    expect(rows[0].groups).toEqual({ 変動費: 1500 });
  });

  it("孫カテゴリもルートグループに1回だけロールアップされる（二重計上しない）", async () => {
    await addVariableRoot("特別費", 20);
    const d = isoOf(weekMon(2));
    // 変動費 > 食費 > 食料品 / 外食（孫）、変動費 > 日用品（子）
    await addTx(ids, { category: "食料品", type: "expense", amount: 4000, date: d });
    await addTx(ids, { category: "外食", type: "expense", amount: 2500, date: d });
    await addTx(ids, { category: "日用品", type: "expense", amount: 500, date: d });
    // もう1本のルート
    await addTx(ids, { category: "特別費", type: "expense", amount: 9000, date: d });

    const { groups, rows } = await getWeeklyProgress(12);
    expect(rows).toHaveLength(1);
    expect(groups.sort()).toEqual(["変動費", "特別費"].sort());
    expect(rows[0].groups).toEqual({ 変動費: 7000, 特別費: 9000 });
    expect(rows[0].total).toBe(16000);
    // 行の合計 == 各列の合計（画面の「合計」列が列の和と一致すること）
    expect(rows[0].total).toBe(Object.values(rows[0].groups).reduce((a, b) => a + b, 0));
  });

  it("月をまたぐ週は1行にまとまり、月次PLは月ごとに分かれる（同じ金額の別の切り方）", async () => {
    // 窓(直近13週)の中から、月曜と日曜の月が違う週を1つ選ぶ
    let k = -1;
    for (let i = 1; i <= 11; i++) {
      if (addDays(weekMon(i), 6).getMonth() !== weekMon(i).getMonth()) {
        k = i;
        break;
      }
    }
    expect(k).toBeGreaterThan(0); // 13週あれば必ず1つはある

    const mon = weekMon(k);
    const sun = addDays(mon, 6);
    await addTx(ids, { category: "食料品", type: "expense", amount: 3300, date: isoOf(mon) }); // 前の月
    await addTx(ids, { category: "外食", type: "expense", amount: 4400, date: isoOf(sun) }); // 次の月

    const { rows } = await getWeeklyProgress(12);
    const w = rows.find((r) => r.week_start === isoOf(mon))!;
    expect(w).toBeDefined();
    expect(w.week_end).toBe(isoOf(sun));
    expect(w.total).toBe(7700); // 週は月をまたいで合算される
    expect(w.week_start.slice(0, 7)).not.toBe(w.week_end.slice(0, 7));

    // 同じ2件は月次PLでは別の月に分かれる
    expect((await getPLSummary(monthPeriodOf(mon))).variable).toBe(3300);
    expect((await getPLSummary(monthPeriodOf(sun))).variable).toBe(4400);
  });

  it("週次の総和が、同じ取引集合の月次変動費の総和と一致する（週⇔月のクロス検証）", async () => {
    const plan: [number, number][] = [
      [0, 1200],
      [1, 3400],
      [3, 560],
      [6, 78900],
      [11, 4321],
    ];
    for (const [k, amt] of plan) {
      await addTx(ids, { category: "食料品", type: "expense", amount: amt, date: isoOf(addDays(weekMon(k), 2)) });
    }
    const expected = 1200 + 3400 + 560 + 78900 + 4321; // 88,381

    const { rows } = await getWeeklyProgress(12);
    expect(rows.reduce((a, r) => a + r.total, 0)).toBe(expected);

    // 同じ取引を「月」で切り直しても合計は同じ
    const months = new Set<string>();
    for (const [k] of plan) months.add(monthPeriodOf(addDays(weekMon(k), 2)));
    let byMonth = 0;
    for (const m of months) byMonth += (await getPLSummary(m)).variable;
    expect(byMonth).toBe(expected);
  });

  it("【現状の記録 / 不具合】getWeeklyProgress(12) は12週ではなく13週ぶんの窓になる", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // 下限が date_trunc('week', CURRENT_DATE) - 12週 = 12週前の月曜 なので、
    // 「12週前の月曜〜今週の日曜」= 13カレンダー週が入る。画面の見出しは「直近12週」。
    await addTx(ids, { category: "食料品", type: "expense", amount: 111, date: isoOf(weekMon(0)) });
    await addTx(ids, { category: "食料品", type: "expense", amount: 222, date: isoOf(weekMon(12)) }); // 境界ちょうど
    await addTx(ids, { category: "食料品", type: "expense", amount: 333, date: isoOf(addDays(weekMon(12), -1)) }); // 1日前

    const { rows } = await getWeeklyProgress(12);
    expect(rows.map((r) => r.week_start)).toEqual([isoOf(weekMon(0)), isoOf(weekMon(12))]);
    expect(rows[1].total).toBe(222); // 12週前の月曜は入る
    expect(rows.some((r) => r.total === 333)).toBe(false); // その前日は入らない

    const oldest = parseIso(rows[rows.length - 1].week_start);
    const spanWeeks = Math.round((MON.getTime() - oldest.getTime()) / (7 * 86400000)) + 1;
    expect(spanWeeks).toBe(13); // ← 12 を期待したいところ
  });

  it("【現状の記録 / 不具合】上限が無いので未来日付の変動費が「直近12週」に混ざる", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // tx CTE に accrual_date の上限が無いため、先の日付で入力した変動費が
    // 最新週として表の一番上に出る（今週より新しい行が「直近12週」に現れる）。
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: isoOf(weekMon(0)) });
    await addTx(ids, { category: "食料品", type: "expense", amount: 99999, date: isoOf(addDays(weekMon(0), 35)) });

    const { rows } = await getWeeklyProgress(12);
    expect(rows).toHaveLength(2);
    expect(rows[0].week_start).toBe(isoOf(addDays(weekMon(0), 35))); // 未来の週が先頭
    expect(rows[0].total).toBe(99999);
    expect(rows.reduce((a, r) => a + r.total, 0)).toBe(100999);
  });

  it("【現状の記録 / 不具合】取引の無い週は行ごと欠落し、表の週が連続しない", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // generate_series で週を作っていないため、支出ゼロの週は行が出ない。
    // /weekly の表は週が飛んだまま縦に並ぶので、隣の行を「先週」と読むとズレる。
    await addTx(ids, { category: "食料品", type: "expense", amount: 5000, date: isoOf(weekMon(0)) });
    await addTx(ids, { category: "食料品", type: "expense", amount: 6000, date: isoOf(weekMon(2)) });

    const { rows } = await getWeeklyProgress(12);
    expect(rows.map((r) => r.week_start)).toEqual([isoOf(weekMon(0)), isoOf(weekMon(2))]);
    expect(rows.map((r) => r.week_start)).not.toContain(isoOf(weekMon(1))); // 0円の週は消える
  });

  it("変動費が1件も無ければ空で返る（例外にならない）", async () => {
    await addTx(ids, { category: "家賃", type: "expense", amount: 120000, date: isoOf(weekMon(0)) });
    const r = await getWeeklyProgress(12);
    expect(r).toEqual({ groups: [], rows: [] });
  });

  it("【現状の記録 / 不具合】同名の変動費ルートが2つあると 合計 と 列の和 が食い違う", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // getWeeklyProgress の roots CTE は is_active を見ないため、
    // 「旧グループを無効化 → 同じ名前で作り直す」（費目管理/ADR-050 で可能な操作）を
    // したあと、同じ週に新旧両方の取引があると
    //   total   … 両方を加算（w.total += r.total）
    //   groups  … 同じキーを上書き（w.groups[name] = r.total）
    // となり、表の「合計」列が各グループ列の和と一致しなくなる。
    const d = isoOf(weekMon(1));
    await addTx(ids, { category: "食料品", type: "expense", amount: 4000, date: d }); // 旧ツリー
    await pool.query(`UPDATE categories SET is_active=false WHERE user_id=$1`, [ids.userId]);
    // 同じ名前で作り直した新ルート＋葉
    const nr = await pool.query(
      `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
       VALUES ($1,NULL,'変動費','variable_cost',false,30) RETURNING id`,
      [ids.userId]
    );
    const nl = await pool.query(
      `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed, display_order)
       VALUES ($1,$2,'食料品','variable_cost',true,31) RETURNING id`,
      [ids.userId, nr.rows[0].id]
    );
    ids.cat["食料品(新)"] = nl.rows[0].id;
    await addTx(ids, { category: "食料品(新)", type: "expense", amount: 6000, date: d });

    const { groups, rows } = await getWeeklyProgress(12);
    expect(groups).toEqual(["変動費"]); // 列は1本しか出ない
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(10000); // 合計は 4,000 + 6,000
    expect(rows[0].groups).toEqual({ 変動費: 6000 }); // 列は後勝ちで 6,000 だけ
    // 本来守られるべき不変条件が破れている
    expect(rows[0].total).not.toBe(Object.values(rows[0].groups).reduce((a, b) => a + b, 0));
  });
});

// =========================================================================
// 6. type と pl_type の不一致（返金の入力など）
// =========================================================================
describe("type と カテゴリのPL区分 が食い違う取引", () => {
  // /api/transactions も入力フォームも「支出/収入」トグルとカテゴリを独立に選ばせるため、
  // 「食料品の返金」を 収入 × 変動費 として登録できてしまう。
  it("【現状の記録 / 不具合】収入×変動費 の取引は年度PL・年計・予実・週次のどこにも計上されない", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // 集計側は type と pl_type の両方が揃った行しか拾わないため、
    // 不一致の行は「収入でも支出でもない」扱いで静かに落ちる。
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-05-10", wallet: "銀行A" });
    // 食料品の返金 8,000 を「収入」として登録（現UIで選べる組み合わせ）
    await addTx(ids, { category: "食料品", type: "income", amount: 8000, date: "2026-05-20", wallet: "銀行A" });

    const fy = await getFiscalYearTotal("2026-04-01");
    expect(fy.income).toBe(0); // 収入にも入らない
    expect(fy.variable).toBe(30000); // 変動費も 22,000 に減らない
    expect(fy.surplus).toBe(-30000); // 実際の持ち出しは 22,000 なのに -30,000

    const may = (await getFiscalYearPL("2026-04-01")).find((r) => r.month === "2026-05")!;
    expect(may).toEqual({ month: "2026-05", income: 0, fixed: 0, variable: 30000, surplus: -30000 });

    const b = await getBudgetVsActual("2026-05-01");
    expect(b.actual_income).toBe(0);
    expect(b.actual_expense).toBe(30000);
  });

  it("【現状の記録 / 不具合】それでも残高は動くので 年間PL と 資産の増減 が突合しない", async () => {
    // これは現状の記録であり、望ましい挙動ではない。
    // 残高側は t.type だけを見て符号を決めるため 8,000 は入金として反映される。
    const before = (await getAssets()).total_assets;
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-05-10", wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "income", amount: 8000, date: "2026-05-20", wallet: "銀行A" });
    const after = (await getAssets()).total_assets;

    expect(before).toBe(520000); // 銀行A 500,000 + 現金 20,000
    expect(after).toBe(498000); // 残高は -22,000
    const fy = await getFiscalYearTotal("2026-04-01");
    expect(fy.surplus).toBe(-30000); // PLは -30,000
    // 8,000 ぶん恒久的にズレる
    expect(after - before).not.toBe(fy.surplus);
    expect(after - before - fy.surplus).toBe(8000);
  });
});

// =========================================================================
// 7. 画面間のクロス検証（/budget と /year が同じ月で同じ数字を出すか）
// =========================================================================
describe("/budget と /year のクロス検証", () => {
  it("getBudgetVsActual の実績 == getFiscalYearPL の同月（収入・支出）", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 321000, date: "2026-04-25" });
    await addTx(ids, { category: "副業収入", type: "income", amount: 12000, date: "2026-04-28" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 129000, date: "2026-04-01" });
    await addTx(ids, { category: "年額サブスク", type: "expense", amount: 11800, date: "2026-04-05" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 42000, date: "2026-04-12" });
    await addTx(ids, { category: "外食", type: "expense", amount: 9800, date: "2026-04-18" });
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 45000, date: "2026-04-25" });
    await addTx(ids, { category: "投資", type: "expense", amount: 50000, date: "2026-04-26" });

    const rows = await getFiscalYearPL("2026-04-01");
    for (const r of rows) {
      const b = await getBudgetVsActual(`${r.month}-01`);
      expect(b.actual_income).toBe(r.income);
      expect(b.actual_expense).toBe(r.fixed + r.variable);
    }
    const apr = rows[0];
    expect(apr).toEqual({ month: "2026-04", income: 333000, fixed: 140800, variable: 51800, surplus: 140400 });
  });
});
