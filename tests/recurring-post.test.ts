// 固定費の実額記録（/api/recurring/post）と月確定（/api/closings）。
//
// 「実額で記録」はマスタの予定額をそのまま transactions に書き込む唯一の経路で、
// ここが1回余分に走ると固定費（＝月次PLで最も大きい費用ライン）が静かに膨らむ。
// 逆に記録した実額が予実の actual に乗らなければ、予定額のままPLが固まる。
// どちらも「エラーにならずに金額だけズレる」類なので、金額を数値で固定して検証する。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, monthStart, type Ids } from "./helpers/fixtures";
import { POST as recordFixedCost } from "@/app/api/recurring/post/route";
import { POST as closeMonth } from "@/app/api/closings/route";
import { POST as createTx } from "@/app/api/transactions/route";
import {
  getFixedCostPlanVsActual,
  getPLSummary,
  getMonthClosed,
  getRecurringRules,
  getRecurringRuleForEdit,
  getFixedCostCategories,
  getWalletBalances,
} from "@/lib/queries";

let ids: Ids;

// 書いた日（2026-09-22）時点の当月 = 2026-09、過去月 = 2026-08。
// getFixedCostPlanVsActual は過去/当月で挙動が変わる（判定は DB の CURRENT_DATE）。
// CUR は固定の対象月として使い、「当月であること」に依存する検証は monthStart(0) で当月を取得する。
const CUR = "2026-09-01";
const PAST = "2026-08-01";

type RuleOpts = {
  name: string;
  category: string;
  amount: number;
  start?: string;
  end?: string | null;
  cycle?: "monthly" | "yearly";
  payMonth?: number | null;
  wallet?: string;
  active?: boolean;
  userId?: number;
};

/** 固定費マスタを1本作る（APIのガードを通さず素のレコードを置きたいので直接INSERT） */
async function addRule(o: RuleOpts): Promise<number> {
  const r = await pool.query(
    `INSERT INTO recurring_rules
       (user_id, name, category_id, amount, settlement_wallet_id,
        start_month, end_month, billing_day, billing_cycle, payment_month, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10) RETURNING id`,
    [
      o.userId ?? ids.userId,
      o.name,
      ids.cat[o.category],
      o.amount,
      ids.wallet[o.wallet ?? "銀行A"],
      o.start ?? "2026-04-01",
      o.end ?? null,
      o.cycle ?? "monthly",
      o.payMonth ?? null,
      o.active ?? true,
    ]
  );
  return r.rows[0].id as number;
}

const post = (b: unknown) =>
  recordFixedCost(
    new Request("http://localhost/api/recurring/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })
  );

const closing = (period: string, closed: boolean) =>
  closeMonth(
    new Request("http://localhost/api/closings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period, closed }),
    })
  );

const addTxApi = (b: unknown) =>
  createTx(
    new Request("http://localhost/api/transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })
  );

/** 期間内の取引を素で読む（集計クエリを信じる前に、生の行を見る） */
async function txIn(period: string) {
  const { rows } = await pool.query(
    `SELECT t.id, t.amount, to_char(t.accrual_date,'YYYY-MM-DD') AS date,
            t.memo, t.client_key, c.name AS category,
            (SELECT count(*)::int FROM transaction_legs l WHERE l.transaction_id=t.id) AS legs,
            (SELECT sum(l.amount)::int FROM transaction_legs l WHERE l.transaction_id=t.id) AS leg_sum
     FROM transactions t JOIN categories c ON c.id=t.category_id
     WHERE t.accrual_date >= $1::date AND t.accrual_date < ($1::date + interval '1 month')
     ORDER BY t.id`,
    [period]
  );
  return rows as {
    id: number;
    amount: number;
    date: string;
    memo: string | null;
    client_key: string | null;
    category: string;
    legs: number;
    leg_sum: number | null;
  }[];
}

const txCount = async () =>
  (await pool.query("select count(*)::int n from transactions")).rows[0].n as number;

/** 予実明細の effective 合計。画面の固定費ライン（app/monthly/page.tsx:42）と同じ式。 */
async function fixedDetailTotal(period: string) {
  const rows = await getFixedCostPlanVsActual(period);
  return rows.reduce((s, f) => s + f.effective, 0);
}

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

describe("実額で記録：正常系", () => {
  it("マスタの予定額がその月の取引になり、予実の実額・PL・残高すべてに同じ額が出る", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    const res = await post({ rule_id: 1, period: CUR });
    expect(res.status).toBe(200);
    // id は bigint なので pg の既定で文字列で返る（JSONでもそのまま文字列）
    expect(await res.json()).toEqual({ ok: true, id: "1" });

    // 生の取引：金額・発生日・脚まで確認する
    const rows = await txIn(CUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: 129987,
      date: "2026-09-01", // 発生日は period の月初に固定される（billing_day=1 は使われない）
      memo: "固定費(マスタから記録): 家賃",
      category: "家賃",
      legs: 1,
      leg_sum: 129987,
    });

    // 予実の実額に出る
    const f = (await getFixedCostPlanVsActual(CUR))[0];
    expect(f).toMatchObject({
      name: "家賃",
      plan: 129987,
      actual: 129987,
      effective: 129987,
      is_actual: true,
      wallet_name: "銀行A",
    });

    // 内部整合：明細の合計 = PLサマリの固定費
    expect(await fixedDetailTotal(CUR)).toBe(129987);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);

    // 引落先の残高からも引かれる（期首50万 − 129,987）
    const bal = await getWalletBalances();
    expect(bal.find((b) => b.name === "銀行A")?.balance).toBe(370013);
  });

  it("amount を明示するとその額で記録され、予定額(plan)は変わらない", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    expect((await post({ rule_id: 1, period: CUR, amount: 131000 })).status).toBe(200);

    const f = (await getFixedCostPlanVsActual(CUR))[0];
    expect(f.plan).toBe(129987); // マスタは書き換わらない
    expect(f.actual).toBe(131000);
    expect(f.effective).toBe(131000);
    expect((await getPLSummary(CUR)).fixed).toBe(131000);
  });

  it("別カテゴリの2本を記録すると、明細の合計とPLサマリが一致する（クロス検証の正常系）", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    await addRule({ name: "スマホ", category: "通信費", amount: 5480 });

    expect((await post({ rule_id: 1, period: CUR })).status).toBe(200);
    expect((await post({ rule_id: 2, period: CUR })).status).toBe(200);

    const rows = await getFixedCostPlanVsActual(CUR);
    expect(rows.map((r) => [r.name, r.actual])).toEqual([
      ["家賃", 129987],
      ["スマホ", 5480],
    ]);
    expect(await fixedDetailTotal(CUR)).toBe(135467);
    expect((await getPLSummary(CUR)).fixed).toBe(135467);
  });

  it("過去月にも記録でき、実額としてそのまま乗る", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    expect((await post({ rule_id: 1, period: PAST, amount: 125000 })).status).toBe(200);

    const f = (await getFixedCostPlanVsActual(PAST))[0];
    expect(f.actual).toBe(125000);
    expect(f.effective).toBe(125000);
    // 当月は未記録のまま。過去月の記録が当月に漏れないこと
    expect((await getFixedCostPlanVsActual(CUR))[0].actual).toBeNull();
    expect((await getPLSummary(CUR)).fixed).toBe(0);
  });

  it("【現状の記録・望ましい挙動ではない】整数でない amount は400にならず、静かに予定額へ差し替わる", async () => {
    // 呼び出し側が 1234.5 を送っても 200 が返り、記録されるのは 129,987。
    // 「言われた額と違う額を、成功として保存する」ため、本来は400で弾くべき。
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    const res = await post({ rule_id: 1, period: CUR, amount: 1234.5 });
    expect(res.status).toBe(200);
    expect((await txIn(CUR))[0].amount).toBe(129987);
  });
});

describe("二重計上の経路", () => {
  it("同じルール・同じ月を続けて2回叩くと、2回目は409で1件のまま", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    expect((await post({ rule_id: 1, period: CUR })).status).toBe(200);
    const second = await post({ rule_id: 1, period: CUR });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("既に実額が記録済み");

    expect(await txCount()).toBe(1);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);
  });

  it("同時に2回叩いても1件しか通らず、もう1件は409になる（client_keyで冪等化）", async () => {
    // 以前はここが二重計上の穴だった（バグ）：route.ts の重複SELECTは BEGIN より前にあり、
    // 冪等キーも一意制約も無かったため、2本のリクエストが並ぶと両方が「未記録」を見て両方INSERTし、
    // 固定費が 129,987 の2倍（259,974）に膨らんでいた。
    // 現在は client_key='rule:<rule_id>:<period>' を付与し、部分ユニーク索引
    // uq_tx_user_client_key(user_id, client_key) が最後の砦になっている。
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    // プールに空きコネクションを2本用意してから同時に叩く。
    // （1本しか温まっていないと、2本目は接続確立の分だけ遅れて直列化してしまい、
    //   本番の同時アクセスを再現できない）
    await Promise.all([pool.query("select 1"), pool.query("select 1"), pool.query("select 1")]);

    const [a, b] = await Promise.all([
      post({ rule_id: 1, period: CUR }),
      post({ rule_id: 1, period: CUR }),
    ]);
    const statuses = [a.status, b.status].sort();

    const rows = await txIn(CUR);
    console.log(
      `\n[同時実行] status=${statuses.join(",")} / 取引=${rows.length}件 / 固定費合計=${
        (await getPLSummary(CUR)).fixed
      }`
    );

    // 勝つのは必ず1本。負けた側は（重複SELECT到達でも23505でも）同じ409メッセージ。
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await loser.json()).error).toContain("既に実額が記録済み");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: 129987,
      client_key: "rule:1:2026-09-01", // 決定的な冪等キー。後からでも同一性を判定できる
      legs: 1,
      leg_sum: 129987, // 負けた側は ROLLBACK されるので孤児の脚も残らない
    });

    // 内部整合：明細合計 = PLサマリの固定費 = 1回分
    expect((await getFixedCostPlanVsActual(CUR))[0].actual).toBe(129987);
    expect(await fixedDetailTotal(CUR)).toBe(129987);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);
    // 残高も1回分しか引かれない（期首50万 − 129,987）
    const bal = await getWalletBalances();
    expect(bal.find((w) => w.name === "銀行A")?.balance).toBe(370013);
  });

  it("記録経路にはDB側の砦がある：同じ冪等キーの再投入は一意違反で止まる", async () => {
    // 以前はこの経路に一意制約が無く（バグ）、アプリのSELECTをすり抜けたら何件でも入った。
    // 現在は client_key='rule:<rule_id>:<period>' ＋ 部分ユニーク索引 uq_tx_user_client_key が、
    // カード消込の uq_card_settlement（db/migrations/007）と同じ役割を果たす。
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    expect((await post({ rule_id: 1, period: CUR })).status).toBe(200);

    // アプリの重複SELECTを迂回しても、同じ client_key はDBが弾く
    await expect(
      pool.query(
        `INSERT INTO transactions(user_id, category_id, type, amount, accrual_date, memo, client_key)
         VALUES ($1,$2,'expense',129987,$3,'固定費(マスタから記録): 家賃','rule:1:2026-09-01')`,
        [ids.userId, ids.cat["家賃"], CUR]
      )
    ).rejects.toMatchObject({ code: "23505" });
    expect(await txCount()).toBe(1);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);

    // 【残る穴】client_key を持たない素のINSERT（手入力相当）は部分索引の対象外なので止まらない。
    // アプリの記録経路は必ず client_key を付けるため実害は限定的だが、DB単体の保証ではない。
    await pool.query(
      `INSERT INTO transactions(user_id, category_id, type, amount, accrual_date, memo)
       VALUES ($1,$2,'expense',129987,$3,'固定費(マスタから記録): 家賃')`,
      [ids.userId, ids.cat["家賃"], CUR]
    );
    expect(await txCount()).toBe(2);
    expect((await getPLSummary(CUR)).fixed).toBe(259974);
  });

  it("年額ルールは月次に記録できず404。明細合計とPLサマリが食い違わない（ADR-035）", async () => {
    // ADR-035：年額サブスクは月次PL・固定費予実に出さない。
    // 以前は post が billing_cycle を見ておらず（バグ）、年額の全額12,000が当月の固定費に乗り、
    // 予実明細（yearly除外）の合計 129,987 と PLサマリ 141,987 が 12,000 食い違っていた。
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    await addRule({
      name: "年額プライム",
      category: "年額サブスク",
      amount: 12000,
      cycle: "yearly",
      payMonth: 9,
    });

    expect((await post({ rule_id: 1, period: CUR })).status).toBe(200); // 月額は通る

    const yearly = await post({ rule_id: 2, period: CUR }); // 年額は入口で止まる
    expect(yearly.status).toBe(404);
    expect((await yearly.json()).error).toContain("年額ルールは月次に記録できません");

    // 取引になったのは月額の1件だけ
    expect(await txCount()).toBe(1);

    // 明細には年額の行が出ない（getFixedCostPlanVsActual は yearly を除外）
    const rows = await getFixedCostPlanVsActual(CUR);
    expect(rows.map((r) => r.name)).toEqual(["家賃"]);

    // 内部整合：明細合計 = PLサマリの固定費（差は0）
    expect(await fixedDetailTotal(CUR)).toBe(129987);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);
    expect((await getPLSummary(CUR)).fixed - (await fixedDetailTotal(CUR))).toBe(0);
  });

  it("同一カテゴリに年額が併存していても、月額ルールの実額が年額の値に化けない", async () => {
    // 「1カテゴリ1ルール」ガード（app/api/recurring/route.ts）は月額どうしだけを見ており、
    // 年額は同じカテゴリに併存できる（tests/recurring-guard.test.ts）。
    // 以前はその年額を post できてしまい（バグ）、突合キーが category_id しか無いため
    // 12,000 が月額行「スマホ」の実額として貼られ、月額側は409で二度と記録できなかった。
    await addRule({ name: "スマホ", category: "通信費", amount: 5000 }); // 月額
    await addRule({
      name: "通信の年払い",
      category: "通信費",
      amount: 12000,
      cycle: "yearly",
      payMonth: 9,
    }); // 年額（同一カテゴリ）
    const cur = await monthStart(0); // 「当月は予定額でフォールバック」を見るため当月で検証する

    const yearly = await post({ rule_id: 2, period: cur }); // 年額は記録できない
    expect(yearly.status).toBe(404);
    expect(await txCount()).toBe(0);

    // 年額が取引にならないので、月額行の実額は空のまま（当月は予定額でフォールバック）
    const before = await getFixedCostPlanVsActual(cur);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      name: "スマホ",
      plan: 5000,
      actual: null,
      effective: 5000,
      is_actual: false,
    });

    // 月額側は塞がれていないので、本来の 5,000 をきちんと記録できる
    expect((await post({ rule_id: 1, period: cur })).status).toBe(200);
    expect(await txCount()).toBe(1);

    const after = await getFixedCostPlanVsActual(cur);
    expect(after[0]).toMatchObject({
      name: "スマホ",
      plan: 5000,
      actual: 5000,
      effective: 5000,
      is_actual: true,
    });
    // 内部整合：明細合計 = PLサマリの固定費
    expect(await fixedDetailTotal(cur)).toBe(5000);
    expect((await getPLSummary(cur)).fixed).toBe(5000);
  });

  it("【現状の記録・望ましい挙動ではない】アクティブ期間外の月にも記録でき、明細に出ない固定費になる", async () => {
    // 解約済み（end_month=2026-07）のルールを 2026-09 に記録する。
    await addRule({ name: "旧プラン", category: "通信費", amount: 4000, end: "2026-07-01" });
    // 未来開始（start_month=2026-12）のルールを 2026-09 に記録する。
    await addRule({ name: "来月開始", category: "家賃", amount: 100000, start: "2026-12-01" });

    expect((await post({ rule_id: 1, period: CUR })).status).toBe(200);
    expect((await post({ rule_id: 2, period: CUR })).status).toBe(200);

    // 予実明細は0行（どちらも当月はアクティブでない）
    expect(await getFixedCostPlanVsActual(CUR)).toHaveLength(0);
    expect(await fixedDetailTotal(CUR)).toBe(0);
    // だがPLの固定費には 104,000 が乗る＝画面のどこにも内訳が出ない固定費
    expect((await getPLSummary(CUR)).fixed).toBe(104000);
  });

  it("手入力の実額が既にある月は409で弾かれる（同一カテゴリの重複は防げている）", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    await addTx(ids, {
      category: "家賃",
      type: "expense",
      amount: 129987,
      date: "2026-09-05",
      wallet: "銀行A",
    });

    const res = await post({ rule_id: 1, period: CUR });
    expect(res.status).toBe(409);
    expect(await txCount()).toBe(1);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);
  });

  it("収入の取引は重複判定に含まれない（type='expense' だけを見ている）", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    await addTx(ids, {
      category: "給与収入(手取り)",
      type: "income",
      amount: 300000,
      date: "2026-09-25",
      wallet: "銀行A",
    });

    expect((await post({ rule_id: 1, period: CUR })).status).toBe(200);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);
    expect((await getPLSummary(CUR)).disposable).toBe(300000);
  });

  it("月が違えば記録できる（前月の記録が当月をブロックしない）", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    expect((await post({ rule_id: 1, period: PAST })).status).toBe(200);
    expect((await post({ rule_id: 1, period: CUR })).status).toBe(200);
    expect(await txCount()).toBe(2);
    expect((await getPLSummary(PAST)).fixed).toBe(129987);
    expect((await getPLSummary(CUR)).fixed).toBe(129987);
  });
});

describe("月確定（closings）", () => {
  it("確定すると3セクションが閉じ、getMonthClosed が true になる。解除で戻る", async () => {
    const res = await closing(CUR, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, closed: true });

    const rows = await pool.query(
      `select section, is_closed, (closed_at is not null) as has_ts
       from monthly_closings where period=$1::date order by section`,
      [CUR]
    );
    expect(rows.rows).toEqual([
      { section: "fixed_cost", is_closed: true, has_ts: true },
      { section: "income", is_closed: true, has_ts: true },
      { section: "variable_cost", is_closed: true, has_ts: true },
    ]);
    expect(await getMonthClosed(CUR)).toBe(true);
    expect(await getMonthClosed(PAST)).toBe(false); // 他の月は巻き込まない

    // 解除：行は残り、is_closed と closed_at だけ戻る
    expect((await closing(CUR, false)).status).toBe(200);
    expect(await getMonthClosed(CUR)).toBe(false);
    const after = await pool.query(
      `select count(*)::int n, count(closed_at)::int ts from monthly_closings where period=$1::date`,
      [CUR]
    );
    expect(after.rows[0]).toEqual({ n: 3, ts: 0 });
  });

  it("2回確定しても行は増えない（UPSERT）", async () => {
    await closing(CUR, true);
    await closing(CUR, true);
    const n = await pool.query(`select count(*)::int n from monthly_closings`);
    expect(n.rows[0].n).toBe(3);
  });

  it("1セクションでも閉じていれば月全体が確定扱いになる（bool_or の仕様）", async () => {
    // closings API は3セクションを一括で閉じるが、getMonthClosed は bool_or。
    // API が書かない 'assets' だけが閉じていても、画面は「※確定」になる。
    await pool.query(
      `insert into monthly_closings (user_id, period, section, is_closed, closed_at)
       values ($1,$2::date,'assets',true,now())`,
      [ids.userId, CUR]
    );
    expect(await getMonthClosed(CUR)).toBe(true);
  });

  it("period の形式が不正なら400で、確定レコードは作られない", async () => {
    expect((await closing("2026-9-01", true)).status).toBe(400);
    expect((await closing("2026-09-15", true)).status).toBe(400);
    const n = await pool.query(`select count(*)::int n from monthly_closings`);
    expect(n.rows[0].n).toBe(0);
  });

  it("【現状の記録・望ましい挙動ではない】確定済みの月にも実額を記録できてしまう", async () => {
    // 画面は確定時にボタンを隠すだけ（app/monthly/page.tsx:140 の `!closed`）で、
    // API 側には確定チェックが一切ない。確定＝「黒塗り」（ADR-020）の数字が後から動く。
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    expect((await closing(CUR, true)).status).toBe(200);
    expect(await getMonthClosed(CUR)).toBe(true);

    const res = await post({ rule_id: 1, period: CUR });
    expect(res.status).toBe(200); // 望ましくは409
    expect((await getPLSummary(CUR)).fixed).toBe(129987);
  });

  it("【現状の記録・望ましい挙動ではない】確定済みの月に通常の取引も追加できてしまう", async () => {
    expect((await closing(CUR, true)).status).toBe(200);

    const res = await addTxApi({
      category_id: ids.cat["食料品"],
      type: "expense",
      amount: 3210,
      accrual_date: "2026-09-20",
      wallet_id: ids.wallet["現金"],
    });
    expect(res.status).toBe(200); // 望ましくは409
    expect((await getPLSummary(CUR)).variable).toBe(3210);
    expect(await getMonthClosed(CUR)).toBe(true); // 確定表示のまま金額だけ増える
  });
});

describe("入力の妥当性とテナント分離", () => {
  it("rule_id / period が不正なら400で、取引は作られない", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });

    const cases: [unknown, number][] = [
      [{ period: CUR }, 400], // rule_id 欠落
      [{ rule_id: 0, period: CUR }, 400],
      [{ rule_id: -1, period: CUR }, 400],
      [{ rule_id: 1.5, period: CUR }, 400],
      [{ rule_id: 1 }, 400], // period 欠落
      [{ rule_id: 1, period: "2026-9-01" }, 400],
      [{ rule_id: 1, period: "2026-09-15" }, 400], // 月初日以外
      [{ rule_id: 1, period: "2026-09" }, 400],
      [{ rule_id: "1", period: CUR }, 200], // 文字列は Number() で1になるので通る（型がゆるいだけ）
    ];
    for (const [body, want] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(want);
    }
    expect(await txCount()).toBe(1); // 通ったのは最後の1件だけ
  });

  it("存在しない／解約(is_active=false)のルールは404", async () => {
    await addRule({ name: "旧プラン", category: "通信費", amount: 4000, active: false });

    expect((await post({ rule_id: 999, period: CUR })).status).toBe(404);
    expect((await post({ rule_id: 1, period: CUR })).status).toBe(404);
    expect(await txCount()).toBe(0);
  });

  it("他ユーザーのルールは記録できない（404）", async () => {
    const other = await pool.query(
      `insert into users (email, display_name, fiscal_year_start_month)
       values ('other@example.com','別人',4) returning id`
    );
    const otherId = other.rows[0].id as number;
    await addRule({ name: "他人の家賃", category: "家賃", amount: 200000, userId: otherId });

    expect((await post({ rule_id: 1, period: CUR })).status).toBe(404);
    expect(await txCount()).toBe(0);
  });
});

describe("固定費マスタの参照クエリ", () => {
  it("getRecurringRules：継続中→終了済み、金額の大きい順に並ぶ", async () => {
    await addRule({ name: "スマホ", category: "通信費", amount: 5480 });
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    await addRule({
      name: "旧プライム",
      category: "年額サブスク",
      amount: 30000,
      end: "2026-07-01",
      cycle: "yearly",
      payMonth: 4,
    });

    const rows = await getRecurringRules();
    expect(rows.map((r) => r.name)).toEqual(["家賃", "スマホ", "旧プライム"]);
    expect(rows[0]).toMatchObject({
      name: "家賃",
      amount: 129987,
      category_name: "家賃",
      wallet_name: "銀行A",
      start_month: "2026-04", // 'YYYY-MM' に整形される
      end_month: null,
      billing_cycle: "monthly",
      is_active: true,
    });
    expect(rows[2]).toMatchObject({
      end_month: "2026-07",
      billing_cycle: "yearly",
      payment_month: 4,
    });
  });

  it("getRecurringRules：解約(is_active=false)も一覧には残る", async () => {
    await addRule({ name: "解約済み", category: "通信費", amount: 4000, active: false });
    const rows = await getRecurringRules();
    expect(rows).toHaveLength(1);
    expect(rows[0].is_active).toBe(false);
  });

  it("getRecurringRuleForEdit：自分のルールは取れ、他人のルール・不存在は null", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 129987 });
    const other = await pool.query(
      `insert into users (email, display_name, fiscal_year_start_month)
       values ('other@example.com','別人',4) returning id`
    );
    await addRule({
      name: "他人の家賃",
      category: "家賃",
      amount: 200000,
      userId: other.rows[0].id,
    });

    expect((await getRecurringRuleForEdit(1))?.name).toBe("家賃");
    expect(await getRecurringRuleForEdit(2)).toBeNull(); // 他ユーザー
    expect(await getRecurringRuleForEdit(999)).toBeNull();
  });

  it("getFixedCostCategories：固定費の入力可・アクティブな葉だけを返す", async () => {
    const rows = await getFixedCostCategories();
    expect(rows.map((r) => r.name)).toEqual(["家賃", "通信費", "年額サブスク"]);
    expect(rows.every((r) => r.pl_type === "fixed_cost")).toBe(true);

    // 集計ノード「固定費」(is_input_allowed=false) も変動費も混ざらない
    expect(rows.map((r) => r.name)).not.toContain("固定費");
    expect(rows.map((r) => r.name)).not.toContain("日用品");

    // 非アクティブは落ちる
    await pool.query("update categories set is_active=false where id=$1", [ids.cat["通信費"]]);
    expect((await getFixedCostCategories()).map((r) => r.name)).toEqual(["家賃", "年額サブスク"]);
  });
});
