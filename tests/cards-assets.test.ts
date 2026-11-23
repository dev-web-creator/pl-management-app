// カード明細（請求サイクル）と資産推移。
//
// この領域の怖さは「落ちない間違い」にある。請求サイクルの切り方が1日ずれても例外は出ないし、
// 推移グラフの棒が数万円低くても画面は普通に描画される。したがってこのファイルは
// 「関数が動くこと」ではなく **金額が合っていること**、とくに
//   ・明細の合計  = getAssets().card_unpaid
//   ・内訳の合計  = getAssets().total_assets
//   ・推移の最終月 = getAssets()
// という内部整合のクロス検証を主軸に据える。
//
// 請求サイクルの判定ロジック（cycleOf）は app/cards/page.tsx の中にあり export されていない。
// ロジックをテストに書き写すと「写したコード」を検証することになってしまうので、
// サーバコンポーネントを直接 await して、返ってきた React 要素ツリーから
// 締めキー・引落日・請求額を読み出す形で **本物のコード** を検証する。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import {
  getAssets,
  getAssetTrend,
  getAssetBreakdown,
  getCardLegs,
  getCardSettlements,
  getCryptoWallets,
  getDividendTrend,
  getForecastInputs,
} from "@/lib/queries";
import { POST as settle } from "@/app/api/cards/settle/route";
import CardsPage from "@/app/cards/page";
import SettleCardButton from "@/components/SettleCardButton";

let ids: Ids;

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// 日付ヘルパ（「今月」に依存する関数のテストが時間経過で腐らないようにする）
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");
const NOW = new Date();
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** off ヶ月前/後の 'YYYY-MM' */
const ym = (off: number) => fmt(new Date(NOW.getFullYear(), NOW.getMonth() + off, 1)).slice(0, 7);
/** off ヶ月前/後の day 日（day<=28 で使うこと） */
const dayIn = (off: number, day: number) => fmt(new Date(NOW.getFullYear(), NOW.getMonth() + off, day));
/** off ヶ月前/後の月末日 */
const eom = (off: number) => fmt(new Date(NOW.getFullYear(), NOW.getMonth() + off + 1, 0));

// ---------------------------------------------------------------------------
// DBヘルパ
// ---------------------------------------------------------------------------
async function addWallet(
  o: { name: string; type: string; initial?: number; include?: boolean; active?: boolean }
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets, is_active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ids.userId, o.name, o.type, o.initial ?? 0, o.include ?? true, o.active ?? true]
  );
  ids.wallet[o.name] = r.rows[0].id;
  return r.rows[0].id;
}

async function addCard(o: {
  name: string;
  closing_day?: number | null;
  closing_eom?: boolean;
  payment_day?: number | null;
  payment_eom?: boolean;
  offset?: number;
}): Promise<number> {
  const r = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets,
                          closing_day, closing_eom, payment_day, payment_eom,
                          payment_month_offset, settlement_wallet_id)
     VALUES ($1,$2,'credit_card',0,false,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      ids.userId,
      o.name,
      o.closing_day ?? null,
      o.closing_eom ?? false,
      o.payment_day ?? null,
      o.payment_eom ?? false,
      o.offset ?? 1,
      ids.wallet["銀行A"],
    ]
  );
  ids.wallet[o.name] = r.rows[0].id;
  return r.rows[0].id;
}

async function addTransfer(o: {
  from: string;
  to: string;
  amount: number;
  date: string;
  fee?: number;
}) {
  await pool.query(
    `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, fee, kind, transfer_date)
     VALUES ($1,$2,$3,$4,$5,'transfer',$6)`,
    [ids.userId, ids.wallet[o.from], ids.wallet[o.to], o.amount, o.fee ?? 0, o.date]
  );
}

async function addSnapshot(wallet: string, date: string, value: number) {
  await pool.query(
    `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
     VALUES ($1,$2,$3,$4)`,
    [ids.userId, ids.wallet[wallet], date, value]
  );
}

async function addCategory(name: string, plType: string, parent: string) {
  const r = await pool.query(
    `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed)
     VALUES ($1,$2,$3,$4,true) RETURNING id`,
    [ids.userId, ids.cat[parent], name, plType]
  );
  ids.cat[name] = r.rows[0].id;
  return r.rows[0].id;
}

async function addRule(o: {
  name: string;
  category: string;
  amount: number;
  start: string;
  end?: string | null;
  cycle?: "monthly" | "yearly";
}) {
  await pool.query(
    `INSERT INTO recurring_rules
       (user_id, name, category_id, amount, settlement_wallet_id, start_month, end_month, billing_cycle)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ids.userId, o.name, ids.cat[o.category], o.amount, ids.wallet["銀行A"], o.start, o.end ?? null, o.cycle ?? "monthly"]
  );
}

const settleReq = (b: unknown) =>
  settle(
    new Request("http://localhost/api/cards/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })
  );

// ---------------------------------------------------------------------------
// /cards のサーバコンポーネントを await して、描画結果から請求サイクルを読み出す
// ---------------------------------------------------------------------------
type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El =>
  typeof n === "object" && n !== null && "type" in (n as object) && "props" in (n as object);

function textOf(n: unknown): string {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isEl(n)) return textOf(n.props?.children);
  return "";
}

function collect(n: unknown, pred: (e: El) => boolean, acc: El[] = []): El[] {
  if (Array.isArray(n)) {
    for (const c of n) collect(c, pred, acc);
    return acc;
  }
  if (isEl(n)) {
    if (pred(n)) acc.push(n);
    collect(n.props?.children, pred, acc);
  }
  return acc;
}

type RenderedCycle = {
  label: string | undefined; // '9/15'（締め）
  pay: string | undefined; // '10/10'（引落）
  total: number; // 請求額
  settled: boolean;
  upcoming: boolean;
  closeKey: string | null; // 消込ボタンに載る 'YYYY-MM-DD'（消込済みだと null）
  payDate: string | null;
  itemCount: number;
};

type RenderedCard = { name: string; cycles: RenderedCycle[] };

async function renderCards(): Promise<{ text: string; cards: RenderedCard[] }> {
  const tree = await CardsPage();
  const sections = collect(tree, (e) => e.type === "section");
  const cards = sections.map((s) => {
    const name = textOf(collect(s, (e) => e.type === "h2")[0]);
    const blocks = collect(
      s,
      (e) =>
        e.type === "div" &&
        typeof e.props.className === "string" &&
        (e.props.className as string).startsWith("border rounded-xl p-3")
    );
    const cycles = blocks.map((b): RenderedCycle => {
      const t = textOf(b);
      const btn = collect(b, (e) => e.type === SettleCardButton)[0];
      const items = collect(
        b,
        (e) => e.type === "div" && e.props.className === "flex justify-between text-xs text-slate-500"
      );
      // 請求額は必ず「その1つの span」から読む。ブロック全文を正規表現で舐めると
      // 直後の明細行の日付（例: '09-15'）まで数字として食ってしまう。
      const totalSpan = collect(b, (e) => e.type === "span" && e.props.className === "font-bold tabular-nums")[0];
      return {
        label: t.match(/(\d+\/\d+) 締め/)?.[1],
        pay: t.match(/→\s*(\d+\/\d+) 引落/)?.[1],
        total: Number(textOf(totalSpan).replace(/[¥,]/g, "")),
        settled: t.includes("消込済み"),
        upcoming: t.includes("次回引落"),
        closeKey: (btn?.props.closeKey as string) ?? null,
        payDate: (btn?.props.payDate as string) ?? null,
        itemCount: items.length,
      };
    });
    return { name, cycles };
  });
  return { text: textOf(tree), cards };
}

// ===========================================================================
describe("getCardLegs（カード明細の素データ）", () => {
  it("クレカの支出脚だけを、カードの締め/支払い設定つきで返す", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 3000, date: "2026-09-10", wallet: "クレカA", memo: "洗剤" });
    // 銀行の支出はカード明細には出ない
    await addTx(ids, { category: "食料品", type: "expense", amount: 1200, date: "2026-09-10", wallet: "銀行A" });
    // 脚なし取引（インポート由来）も出ない
    await addTx(ids, { category: "外食", type: "expense", amount: 4500, date: "2026-09-11" });

    const legs = await getCardLegs();
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      card_name: "クレカA",
      closing_day: 15,
      closing_eom: false,
      payment_day: 10,
      payment_eom: false,
      payment_month_offset: 1,
      settlement_name: "銀行A",
      date: "2026-09-10",
      amount: 3000,
      category: "日用品",
      memo: "洗剤",
    });
    expect(String(legs[0].card_id)).toBe(String(ids.wallet["クレカA"]));
  });

  it("カード×発生日の昇順で返る（サイクルの組み立て順の前提）", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 100, date: "2026-09-20", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 200, date: "2026-09-02", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 300, date: "2026-09-11", wallet: "クレカA" });
    const legs = await getCardLegs();
    expect(legs.map((l) => l.date)).toEqual(["2026-09-02", "2026-09-11", "2026-09-20"]);
  });

  // ── 不具合の記録 ──────────────────────────────────────────────
  // getCardLegs は t.type='expense' で絞っている。クレカへの返金・キャッシュバックを
  // 「収入 + 決済手段=クレカA」で記録すると（入力フォームは収入でも決済手段を選べる）、
  // カード残高（= 未払い）からは差し引かれるのに、カード明細＝請求額には現れない。
  // その結果 /cards が提示する消込額が実際の未払いより大きくなる。
  // これは現状の記録であり、望ましい挙動ではない。
  it("【不具合の記録】カードへの返金(収入)は明細に出ず、請求額が未払いより大きくなる", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
    await addTx(ids, { category: "副業収入", type: "income", amount: 5000, date: "2026-09-12", wallet: "クレカA", memo: "返品返金" });

    // カード残高から見た本当の未払いは 25,000
    expect((await getAssets()).card_unpaid).toBe(25000);

    // ところが明細は支出脚しか拾わないので 30,000 のまま
    const legs = await getCardLegs();
    expect(legs).toHaveLength(1);
    expect(legs.reduce((s, l) => s + l.amount, 0)).toBe(30000);

    // /cards の消込ボタンにも 30,000 が載る（5,000 多く銀行から引かれる）
    const { cards } = await renderCards();
    expect(cards[0].cycles[0].total).toBe(30000);
    expect(cards[0].cycles[0].closeKey).toBe("2026-09-15");
  });
});

// ===========================================================================
describe("請求サイクルの判定（app/cards/page.tsx の cycleOf）", () => {
  it("締め日当日は当月サイクル、その翌日は翌月サイクル", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-09-15", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: "2026-09-16", wallet: "クレカA" });

    const { cards } = await renderCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe("クレカA");
    // 新しい締め順に並ぶ
    expect(cards[0].cycles.map((c) => [c.closeKey, c.payDate, c.total])).toEqual([
      ["2026-10-15", "2026-11-10", 2000],
      ["2026-09-15", "2026-10-10", 1000],
    ]);
    expect(cards[0].cycles.map((c) => c.label)).toEqual(["10/15", "9/15"]);
    expect(cards[0].cycles.map((c) => c.pay)).toEqual(["11/10", "10/10"]);
  });

  it("同じサイクル内の複数取引は合算され、明細行としても全部出る", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 1200, date: "2026-09-02", wallet: "クレカA" });
    await addTx(ids, { category: "外食", type: "expense", amount: 3400, date: "2026-09-14", wallet: "クレカA" });
    await addTx(ids, { category: "通信費", type: "expense", amount: 5600, date: "2026-08-16", wallet: "クレカA" });

    const { cards } = await renderCards();
    const cyc = cards[0].cycles;
    expect(cyc).toHaveLength(1); // 8/16・9/02・9/14 はすべて 9/15締め
    expect(cyc[0].closeKey).toBe("2026-09-15");
    expect(cyc[0].total).toBe(1200 + 3400 + 5600);
    expect(cyc[0].itemCount).toBe(3);
  });

  it("年をまたぐ（12/16 の利用は翌年 1/15 締め・2/10 引落）", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 7000, date: "2026-12-16", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 900, date: "2026-12-15", wallet: "クレカA" });

    const { cards } = await renderCards();
    expect(cards[0].cycles.map((c) => [c.closeKey, c.payDate])).toEqual([
      ["2027-01-15", "2027-02-10"],
      ["2026-12-15", "2027-01-10"],
    ]);
  });

  it("月末締め・月末払い（closing_eom / payment_eom）", async () => {
    await addCard({ name: "月末カード", closing_eom: true, payment_eom: true, offset: 1 });
    // 2月（28日まで）と4月（30日まで）で丸めが効くか
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-02-01", wallet: "月末カード" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: "2026-02-28", wallet: "月末カード" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 4000, date: "2026-04-30", wallet: "月末カード" });

    const { cards } = await renderCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].cycles.map((c) => [c.closeKey, c.payDate, c.total])).toEqual([
      ["2026-04-30", "2026-05-31", 4000],
      ["2026-02-28", "2026-03-31", 3000],
    ]);
  });

  it("締め日31日は短い月で月末に丸められる", async () => {
    await addCard({ name: "31日カード", closing_day: 31, payment_day: 27, offset: 1 });
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-02-10", wallet: "31日カード" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: "2026-04-30", wallet: "31日カード" });

    const { cards } = await renderCards();
    expect(cards[0].cycles.map((c) => [c.closeKey, c.payDate, c.total])).toEqual([
      ["2026-04-30", "2026-05-27", 2000],
      ["2026-02-28", "2026-03-27", 1000],
    ]);
  });

  it("締め日30日: 1/31の利用は翌サイクルに送られ、2/28締めに丸められる", async () => {
    await addCard({ name: "30日カード", closing_day: 30, payment_day: 10, offset: 1 });
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-01-30", wallet: "30日カード" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: "2026-01-31", wallet: "30日カード" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 4000, date: "2026-02-28", wallet: "30日カード" });

    const { cards } = await renderCards();
    // 1/31 と 2/28 は同じサイクル（1/30締めの次＝2月末締め）に入る
    expect(cards[0].cycles.map((c) => [c.closeKey, c.payDate, c.total])).toEqual([
      ["2026-02-28", "2026-03-10", 6000],
      ["2026-01-30", "2026-02-10", 1000],
    ]);
  });

  it("支払いが2ヶ月後（payment_month_offset=2）でも年跨ぎが正しい", async () => {
    await addCard({ name: "2ヶ月後カード", closing_day: 20, payment_day: 5, offset: 2 });
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-11-21", wallet: "2ヶ月後カード" });

    const { cards } = await renderCards();
    // 11/21 → 12/20締め → 2ヶ月後の 2/5 引落
    expect(cards[0].cycles.map((c) => [c.closeKey, c.payDate])).toEqual([["2026-12-20", "2027-02-05"]]);
  });

  it("カードが複数あっても混ざらない", async () => {
    await addCard({ name: "末締めカード", closing_eom: true, payment_day: 27, offset: 1 });
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-09-20", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: "2026-09-20", wallet: "末締めカード" });

    const { cards } = await renderCards();
    expect(cards.map((c) => c.name)).toEqual(["クレカA", "末締めカード"]);
    expect(cards[0].cycles.map((c) => [c.closeKey, c.payDate, c.total])).toEqual([["2026-10-15", "2026-11-10", 1000]]);
    expect(cards[1].cycles.map((c) => [c.closeKey, c.payDate, c.total])).toEqual([["2026-09-30", "2026-10-27", 2000]]);
  });

  it("クレカ利用がゼロなら空メッセージ（セクション自体が無い）", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 900, date: "2026-09-10", wallet: "現金" });
    const { text, cards } = await renderCards();
    expect(cards).toHaveLength(0);
    expect(text).toContain("クレカでの支払いがまだありません");
  });
});

// ===========================================================================
describe("消込済みサイクルと未消込サイクルの区別", () => {
  it("消込済みサイクルはバッジが付き、消込ボタンが消える", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-09-15", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: "2026-09-16", wallet: "クレカA" });

    const before = await renderCards();
    expect(before.cards[0].cycles.every((c) => !c.settled)).toBe(true);

    const res = await settleReq({
      card_id: ids.wallet["クレカA"],
      close_key: "2026-09-15",
      amount: 1000,
      pay_date: "2026-10-10",
    });
    expect(res.status).toBe(200);

    const after = await renderCards();
    const [oct, sep] = after.cards[0].cycles;
    expect(sep.label).toBe("9/15");
    expect(sep.settled).toBe(true);
    expect(sep.closeKey).toBeNull(); // ボタンなし＝二重消込の入口が閉じる
    expect(sep.total).toBe(1000); // 金額表示は残る
    expect(oct.settled).toBe(false);
    expect(oct.closeKey).toBe("2026-10-15");
  });

  it("未消込サイクルの合計が getAssets().card_unpaid と一致する", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-09-15", wallet: "クレカA" });
    await addTx(ids, { category: "外食", type: "expense", amount: 2000, date: "2026-09-16", wallet: "クレカA" });
    await addTx(ids, { category: "通信費", type: "expense", amount: 4000, date: "2026-10-16", wallet: "クレカA" });

    expect((await getAssets()).card_unpaid).toBe(7000);

    await settleReq({
      card_id: ids.wallet["クレカA"],
      close_key: "2026-09-15",
      amount: 1000,
      pay_date: "2026-10-10",
    });

    const { cards } = await renderCards();
    const unsettled = cards[0].cycles.filter((c) => !c.settled);
    expect(unsettled.map((c) => c.closeKey)).toEqual(["2026-11-15", "2026-10-15"]);
    expect(unsettled.reduce((s, c) => s + c.total, 0)).toBe(6000);
    expect((await getAssets()).card_unpaid).toBe(6000);
  });

  it("消込は締めキー単位。別サイクルは未消込のまま残る", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-09-15", wallet: "クレカA" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: "2026-09-16", wallet: "クレカA" });
    await settleReq({
      card_id: ids.wallet["クレカA"],
      close_key: "2026-10-15",
      amount: 2000,
      pay_date: "2026-11-10",
    });
    const { cards } = await renderCards();
    expect(cards[0].cycles.map((c) => [c.label, c.settled])).toEqual([
      ["10/15", true],
      ["9/15", false],
    ]);
  });

  // ── 不具合の記録 ──────────────────────────────────────────────
  // 「次回引落」の判定（app/cards/page.tsx）は引落日が今日以降のサイクルから最も近い1件を選ぶが、
  // 消込済みかどうかを見ていない。直近サイクルを消し込むと、その枠が「次回引落」を
  // 消費してしまい、本当に次に引き落とされるサイクルがどこにも強調されなくなる。
  // 金額はズレないが、支払い準備の目印が消える。これは現状の記録であり望ましい挙動ではない。
  it("【不具合の記録】直近サイクルを消込むと「次回引落」の表示が消える", async () => {
    // 今月1日利用 → 今月15日締め → 翌月10日引落（必ず未来）
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: dayIn(0, 1), wallet: "クレカA" });
    // 翌月1日利用 → 翌月15日締め → 翌々月10日引落
    await addTx(ids, { category: "日用品", type: "expense", amount: 2000, date: dayIn(1, 1), wallet: "クレカA" });

    const before = await renderCards();
    expect(before.cards[0].cycles.filter((c) => c.upcoming)).toHaveLength(1);
    const nearest = before.cards[0].cycles.find((c) => c.upcoming)!;
    expect(nearest.total).toBe(1000); // 引落日が近い方

    await settleReq({
      card_id: ids.wallet["クレカA"],
      close_key: nearest.closeKey,
      amount: 1000,
      pay_date: nearest.payDate,
    });

    const after = await renderCards();
    // 望ましい挙動: 残った 2,000 のサイクルが「次回引落」になること
    // 現状: どのサイクルにも「次回引落」が付かない
    expect(after.cards[0].cycles.filter((c) => c.upcoming)).toHaveLength(0);
    expect(after.cards[0].cycles.filter((c) => c.settled)).toHaveLength(1);
  });
});

// ===========================================================================
describe("getCardSettlements", () => {
  it("消込した締めキーを card_id つきで返す", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-09-15", wallet: "クレカA" });
    expect(await getCardSettlements()).toEqual([]);

    await settleReq({
      card_id: ids.wallet["クレカA"],
      close_key: "2026-09-15",
      amount: 1000,
      pay_date: "2026-10-10",
    });
    const s = await getCardSettlements();
    expect(s).toHaveLength(1);
    expect(s[0].close_key).toBe("2026-09-15");
    expect(String(s[0].card_id)).toBe(String(ids.wallet["クレカA"]));
  });

  it("getCardLegs.card_id と getCardSettlements.card_id は同じ型で返る（消込判定の前提）", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 1000, date: "2026-09-15", wallet: "クレカA" });
    await settleReq({
      card_id: ids.wallet["クレカA"],
      close_key: "2026-09-15",
      amount: 1000,
      pay_date: "2026-10-10",
    });
    const leg = (await getCardLegs())[0];
    const st = (await getCardSettlements())[0];
    // /cards は `${card_id}:${close_key}` の文字列キーで突き合わせる。
    // 片方だけ型が変わると消込済みが検出されず、二重消込ボタンが出てしまう。
    expect(typeof leg.card_id).toBe(typeof st.card_id);
    expect(`${leg.card_id}`).toBe(`${st.card_id}`);
  });

  it("card_settlement 以外の振替は、memoが似ていても拾わない", async () => {
    await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, kind, transfer_date, memo)
       VALUES ($1,$2,$3,5000,'transfer',$4,'クレカ消込:2026-08-15締め')`,
      [ids.userId, ids.wallet["銀行A"], ids.wallet["クレカA"], "2026-09-10"]
    );
    expect(await getCardSettlements()).toEqual([]);
  });
});

// ===========================================================================
describe("getAssetTrend（月末残高の推移）", () => {
  it("取引ゼロでも直近6ヶ月が期首残高で埋まる", async () => {
    const t = await getAssetTrend();
    expect(t).toHaveLength(6);
    expect(t.map((p) => p.month)).toEqual([ym(-5), ym(-4), ym(-3), ym(-2), ym(-1), ym(0)]);
    expect(t.every((p) => p.total_assets === 520000 && p.net_assets === 520000)).toBe(true);
    const a = await getAssets();
    expect(t[5]).toEqual({ month: ym(0), total_assets: a.total_assets, net_assets: a.net_assets });
  });

  it("ウォレットが1つも無ければ 0 が並ぶ（境界）", async () => {
    await pool.query("DELETE FROM wallets WHERE user_id=$1", [ids.userId]);
    const t = await getAssetTrend();
    expect(t).toHaveLength(6);
    expect(t.every((p) => p.total_assets === 0 && p.net_assets === 0)).toBe(true);
    expect(await getAssets()).toEqual({ total_assets: 0, card_unpaid: 0, net_assets: 0 });
  });

  it("各月末で取引が積み上がり、最終月が getAssets と一致する", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 100000, date: dayIn(-2, 10), wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 5000, date: dayIn(-1, 10), wallet: "現金" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: dayIn(0, 1), wallet: "クレカA" });

    const t = await getAssetTrend();
    expect(t.map((p) => [p.month, p.total_assets, p.net_assets])).toEqual([
      [ym(-5), 520000, 520000],
      [ym(-4), 520000, 520000],
      [ym(-3), 520000, 520000],
      [ym(-2), 620000, 620000],
      [ym(-1), 615000, 615000],
      [ym(0), 615000, 585000], // クレカ未払い 30,000 は純資産からのみ引かれる
    ]);

    const a = await getAssets();
    expect(a).toEqual({ total_assets: 615000, card_unpaid: 30000, net_assets: 585000 });
    expect(t[5].total_assets).toBe(a.total_assets);
    expect(t[5].net_assets).toBe(a.net_assets);
  });

  it("カード消込後も、推移の最終月が getAssets と一致する", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: dayIn(-1, 10), wallet: "クレカA" });
    const before = await getAssetTrend();
    expect(before[5]).toEqual({ month: ym(0), total_assets: 520000, net_assets: 490000 });

    await settleReq({
      card_id: ids.wallet["クレカA"],
      close_key: eom(-1),
      amount: 30000,
      pay_date: dayIn(0, 10),
    });

    const a = await getAssets();
    const t = await getAssetTrend();
    // 銀行から30,000出て、カード未払いが消える。総資産は減り、純資産は変わらない。
    expect(a).toEqual({ total_assets: 490000, card_unpaid: 0, net_assets: 490000 });
    expect(t[5]).toEqual({ month: ym(0), total_assets: 490000, net_assets: 490000 });
  });

  // ── 不具合の記録 ──────────────────────────────────────────────
  // getAssets は日付を見ないので未来日付の取引を「現在の総資産」に含めるが、
  // getAssetTrend は各月末までで打ち切るため最終月（＝今月）には含めない。
  // /assets の見出しの「総資産」と、その下のグラフの一番右の棒が食い違う。
  // 未来日付の取引は入力フォームから普通に登録でき、実際に過去
  // （ADR-045 のインポータが未来3ヶ月分を取り込んだ件）にも発生している。
  // これは現状の記録であり、望ましい挙動ではない。
  it("【不具合の記録】未来日付の取引で、総資産の数字とグラフ最終月が食い違う", async () => {
    await addTx(ids, { category: "家賃", type: "expense", amount: 40700, date: dayIn(2, 1), wallet: "銀行A" });

    const a = await getAssets();
    expect(a.total_assets).toBe(479300); // 未来の支出が今の総資産から引かれている

    const t = await getAssetTrend();
    expect(t[t.length - 1].month).toBe(ym(0));
    expect(t[t.length - 1].total_assets).toBe(520000); // グラフ側は含めない
    expect(t[t.length - 1].total_assets - a.total_assets).toBe(40700);
  });

  it("振替は出金月に反映され、手数料も引かれる", async () => {
    await addTransfer({ from: "銀行A", to: "現金", amount: 50000, date: dayIn(-2, 10), fee: 220 });
    const t = await getAssetTrend();
    // 銀行→現金は総資産の中の移動。手数料 220 だけ総資産が減る。
    expect(t.map((p) => p.total_assets)).toEqual([520000, 520000, 520000, 519780, 519780, 519780]);
    expect((await getAssets()).total_assets).toBe(519780);
  });

  it("crypto は各月末時点の最新スナップショットで評価される", async () => {
    await addWallet({ name: "ETH", type: "crypto" });
    await addTransfer({ from: "銀行A", to: "ETH", amount: 200000, date: dayIn(-3, 10) });
    await addSnapshot("ETH", eom(-3), 200000);
    await addSnapshot("ETH", eom(-1), 260000);

    const t = await getAssetTrend();
    expect(t.map((p) => p.total_assets)).toEqual([
      520000, // -5: まだ振替もスナップショットも無い
      520000, // -4
      520000, // -3: 銀行 -200,000 / 評価額 +200,000
      520000, // -2: 評価額は -3 月末のものを引き継ぐ
      580000, // -1: 評価額 260,000 に更新
      580000, // 0
    ]);
    const a = await getAssets();
    expect(a.total_assets).toBe(580000);
    expect(t[5].total_assets).toBe(a.total_assets);
  });

  // ── 不具合の記録 ──────────────────────────────────────────────
  // crypto 残高は「最新スナップショットを正とし、それより後の振替を加算する」設計
  // （ADR-043 / docs/decisions.md の修正③）。この加算は getWalletBalances / getAssets /
  // 以前はバグだった: getAssetTrend だけ crypto のスナップショット後の振替を加算しておらず、
  // さらに CROSS JOIN のため評価額未入力の crypto は行ごと落ちていた。
  // 同じ /assets 画面で「総資産」の数字とグラフ最終月の棒が食い違う状態だった（ADR-055 で修正）。
  it("スナップショット後の crypto への振替が推移グラフにも反映される", async () => {
    await addWallet({ name: "ETH", type: "crypto" });
    await addSnapshot("ETH", eom(-1), 200000);
    await addTransfer({ from: "銀行A", to: "ETH", amount: 50000, date: dayIn(0, 1) });

    const a = await getAssets();
    expect(a.total_assets).toBe(720000); // 銀行450,000 + 現金20,000 + ETH 250,000

    const t = await getAssetTrend();
    // グラフ最終月は総資産タイルと一致すること（以前は 670,000 で 50,000 消えていた）
    expect(t[5].total_assets).toBe(720000);
    expect(a.total_assets - t[5].total_assets).toBe(0);
  });

  it("スナップショット未入力の crypto でも推移グラフから資産が消えない", async () => {
    await addWallet({ name: "ETH", type: "crypto" });
    await addTransfer({ from: "銀行A", to: "ETH", amount: 150000, date: dayIn(-2, 10) });

    // 評価額未入力なら getAssets は集計ベース（=振り込んだ額）で持つので総資産は変わらない
    const a = await getAssets();
    expect(a.total_assets).toBe(520000);

    const t = await getAssetTrend();
    // 銀行から出た分を crypto 側が受け取るので、どの月も総額は不変
    // （以前は振替月以降が 370,000 に落ち、買い増すほど右肩下がりに見えていた）
    expect(t.map((p) => p.total_assets)).toEqual([520000, 520000, 520000, 520000, 520000, 520000]);
    expect(a.total_assets - t[5].total_assets).toBe(0);
  });

  // ── 不具合の記録 ──────────────────────────────────────────────
  // getAssetTrend のカード残高は「脚＋振替」だけで、wallets.initial_balance を足していない。
  // 一方 getAssets のカード残高は initial_balance を含む。
  // カットオーバーでカードの期首残高に未払い残（マイナス）を入れると
  // （/settings のウォレット管理で入力可能、db/cleanup/002_sync_initial_balance.sql も
  //  crypto 以外を対象に initial_balance を実残高へ寄せる）、
  // 推移グラフの純資産だけがその額だけ高く出続ける。
  // これは現状の記録であり、望ましい挙動ではない。
  it("【不具合の記録】カードの期首残高（繰越未払い）が推移グラフの純資産に載らない", async () => {
    await pool.query("UPDATE wallets SET initial_balance=-40000 WHERE id=$1", [ids.wallet["クレカA"]]);

    const a = await getAssets();
    expect(a).toEqual({ total_assets: 520000, card_unpaid: 40000, net_assets: 480000 });

    const t = await getAssetTrend();
    expect(t[5].total_assets).toBe(520000); // 総資産は一致
    // 望ましい挙動: 480000
    expect(t[5].net_assets).toBe(520000); // 未払い 40,000 が純資産に反映されない
    expect(t[5].net_assets - a.net_assets).toBe(40000);
  });

  it("【不具合の記録】資産に含めないウォレットの扱いが getAssets と推移で食い違う", async () => {
    // include_in_assets=false は現行UIからは設定できず、API直叩き/SQLのみ到達可能。
    // getAssets.net_assets は全ウォレットを合計するのに対し、getAssetTrend は
    // include_in_assets のものしか足さないため、同じ「純資産」が2つの値を持つ。
    // これは現状の記録であり、望ましい挙動ではない。
    await addWallet({ name: "対象外口座", type: "bank", initial: 300000, include: false });

    const a = await getAssets();
    expect(a.total_assets).toBe(520000);
    expect(a.net_assets).toBe(820000); // 資産に含めない口座まで純資産には入る

    const t = await getAssetTrend();
    expect(t[5].total_assets).toBe(520000);
    expect(t[5].net_assets).toBe(520000); // 望ましい挙動: getAssets と揃うこと
  });
});

// ===========================================================================
describe("getAssetBreakdown（種別別の内訳）", () => {
  it("内訳の合計が getAssets().total_assets と一致する", async () => {
    await addWallet({ name: "PayPay残高", type: "prepaid", initial: 3000 });
    await addWallet({ name: "ETH", type: "crypto" });
    await addSnapshot("ETH", eom(-1), 180000);
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 100000, date: dayIn(-1, 10), wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 5000, date: dayIn(-1, 12), wallet: "現金" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: dayIn(0, 1), wallet: "クレカA" });

    const b = await getAssetBreakdown();
    const a = await getAssets();
    expect(b).toEqual([
      { type: "bank", total: 600000 },
      { type: "crypto", total: 180000 },
      { type: "cash", total: 15000 },
      { type: "prepaid", total: 3000 },
    ]);
    expect(b.reduce((s, x) => s + x.total, 0)).toBe(a.total_assets);
    expect(a.total_assets).toBe(798000);
    // クレカは内訳に出ない（未払いは資産ではない）
    expect(b.find((x) => x.type === "credit_card")).toBeUndefined();
  });

  it("同一種別は合算され、合計0の種別は行ごと消える（合計は保たれる）", async () => {
    await addWallet({ name: "銀行B", type: "bank", initial: 300000 });
    await addWallet({ name: "PASMO", type: "prepaid", initial: 0 });
    await addTransfer({ from: "銀行A", to: "PASMO", amount: 5000, date: dayIn(-1, 5) });
    await addTx(ids, { category: "食料品", type: "expense", amount: 5000, date: dayIn(-1, 6), wallet: "PASMO" });

    const b = await getAssetBreakdown();
    const a = await getAssets();
    expect(b).toEqual([
      { type: "bank", total: 795000 }, // 500,000 - 5,000 + 300,000
      { type: "cash", total: 20000 },
    ]);
    expect(b.find((x) => x.type === "prepaid")).toBeUndefined(); // 残高0なので非表示
    expect(b.reduce((s, x) => s + x.total, 0)).toBe(a.total_assets);
  });

  it("資産ゼロなら内訳も空（境界）", async () => {
    await pool.query("DELETE FROM wallets WHERE user_id=$1", [ids.userId]);
    expect(await getAssetBreakdown()).toEqual([]);
  });

  it("crypto はスナップショット後の振替も含めて内訳に出る（getAssets と同じ計算）", async () => {
    await addWallet({ name: "ETH", type: "crypto" });
    await addSnapshot("ETH", eom(-1), 200000);
    await addTransfer({ from: "銀行A", to: "ETH", amount: 50000, date: dayIn(0, 1) });

    const b = await getAssetBreakdown();
    const a = await getAssets();
    expect(b.find((x) => x.type === "crypto")?.total).toBe(250000);
    expect(b.reduce((s, x) => s + x.total, 0)).toBe(a.total_assets);
    expect(a.total_assets).toBe(720000);
  });
});

// ===========================================================================
describe("getCryptoWallets", () => {
  it("最新のスナップショットだけを返し、未入力は null", async () => {
    await addWallet({ name: "ETH", type: "crypto" });
    await addWallet({ name: "BTC", type: "crypto" });
    await addSnapshot("ETH", eom(-2), 100000);
    await addSnapshot("ETH", eom(-1), 130000);

    const w = await getCryptoWallets();
    expect(w.map((x) => [x.name, x.value, x.as_of])).toEqual([
      ["ETH", 130000, eom(-1)],
      ["BTC", null, null],
    ]);
  });

  it("crypto 以外・無効なウォレットは返らない", async () => {
    await addWallet({ name: "ETH", type: "crypto" });
    await addWallet({ name: "廃止XRP", type: "crypto", active: false });
    const w = await getCryptoWallets();
    expect(w.map((x) => x.name)).toEqual(["ETH"]);
  });

  it("crypto が1つも無ければ空配列（境界）", async () => {
    expect(await getCryptoWallets()).toEqual([]);
  });
});

// ===========================================================================
describe("getDividendTrend", () => {
  beforeEach(async () => {
    await addCategory("投資収益(配当)", "income", "収入");
  });

  it("配当の収入だけを月次で合計する", async () => {
    await addTx(ids, { category: "投資収益(配当)", type: "income", amount: 1200, date: "2026-05-10", wallet: "銀行A" });
    await addTx(ids, { category: "投資収益(配当)", type: "income", amount: 3400, date: "2026-05-20", wallet: "銀行A" });
    await addTx(ids, { category: "投資収益(配当)", type: "income", amount: 500, date: "2026-08-01", wallet: "銀行A" });
    // 配当以外の収入は入らない
    await addTx(ids, { category: "副業収入", type: "income", amount: 99999, date: "2026-05-11", wallet: "銀行A" });
    // 同カテゴリでも支出は入らない
    await addTx(ids, { category: "投資収益(配当)", type: "expense", amount: 700, date: "2026-05-12", wallet: "銀行A" });

    expect(await getDividendTrend()).toEqual([
      { month: "2026-05", total: 4600 },
      { month: "2026-08", total: 500 },
    ]);
  });

  it("配当が無ければ空配列（境界）", async () => {
    expect(await getDividendTrend()).toEqual([]);
  });

  // ── 不具合の記録 ──────────────────────────────────────────────
  // 集計条件がカテゴリ名の完全一致（'投資収益(配当)'）のみ。ユーザーがカテゴリを
  // 改名したり全角括弧で作り直すと、収入としては計上されるのに配当推移だけ静かに空になる。
  // カテゴリ管理画面から改名は可能。これは現状の記録であり、望ましい挙動ではない。
  it("【不具合の記録】カテゴリ名が1文字でも違うと配当推移から消える", async () => {
    await addCategory("投資収益（配当）", "income", "収入"); // 全角括弧
    await addTx(ids, { category: "投資収益（配当）", type: "income", amount: 5000, date: "2026-05-10", wallet: "銀行A" });
    expect(await getDividendTrend()).toEqual([]);
  });
});

// ===========================================================================
describe("getForecastInputs", () => {
  it("月次の実績・目標・純資産を返す（控除はどの区分にも入らない）", async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-05-25", wallet: "銀行A" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 80000, date: "2026-05-01", wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 20000, date: "2026-05-10", wallet: "現金" });
    await addTx(ids, { category: "社会保険料", type: "expense", amount: 40000, date: "2026-05-25", wallet: "銀行A" });
    await addTx(ids, { category: "投資", type: "expense", amount: 50000, date: "2026-05-26", wallet: "銀行A" });
    await pool.query(
      `INSERT INTO targets (user_id, period, metric, amount) VALUES ($1,'2026-06-01','income',400000),($1,'2026-06-01','expense',250000),($1,'2026-06-01','total_assets',9000000)`,
      [ids.userId]
    );

    const f = await getForecastInputs();
    expect(f.fyStartMonth).toBe(4);
    expect(f.actuals).toEqual([{ month: "2026-05", income: 300000, fixed: 80000, variable: 20000 }]);
    // total_assets の目標はフォーキャストの入力には渡さない
    expect(f.targets.sort((a, b) => a.metric.localeCompare(b.metric))).toEqual([
      { period: "2026-06", metric: "expense", amount: 250000 },
      { period: "2026-06", metric: "income", amount: 400000 },
    ]);
    expect(f.netAssets).toBe((await getAssets()).net_assets);
    expect(f.netAssets).toBe(520000 + 300000 - 80000 - 20000 - 40000 - 50000);
  });

  it("定期ルールは開始/終了月つきで返る", async () => {
    await addRule({ name: "家賃", category: "家賃", amount: 80000, start: "2026-04-01" });
    await addRule({ name: "旧回線", category: "通信費", amount: 4000, start: "2026-01-01", end: "2026-06-01" });
    const f = await getForecastInputs();
    expect(f.rules.sort((a, b) => b.amount - a.amount)).toEqual([
      { amount: 80000, start_month: "2026-04", end_month: null },
      { amount: 4000, start_month: "2026-01", end_month: "2026-06" },
    ]);
  });

  // ── 不具合の記録 ──────────────────────────────────────────────
  // SQL が billing_cycle='monthly' で絞っているため、年額サブスク（ADR-035）が
  // フォーキャストの固定費計画から丸ごと落ちる。/forecast は返ってきた rules を
  // そのまま「その月に有効な月額固定費の合計」として未来月の費用に積むので、
  // 年額契約を持っているほど5か年の費用が静かに過小になる。
  // これは現状の記録であり、望ましい挙動ではない。
  it("【不具合の記録】年額サブスクの定期ルールがフォーキャスト入力から落ちる", async () => {
    await addRule({ name: "月額回線", category: "通信費", amount: 5000, start: "2026-04-01" });
    await addRule({ name: "年額サブスク", category: "年額サブスク", amount: 12000, start: "2026-04-01", cycle: "yearly" });

    const rows = await pool.query(`SELECT count(*)::int n FROM recurring_rules WHERE user_id=$1`, [ids.userId]);
    expect(rows.rows[0].n).toBe(2);

    const f = await getForecastInputs();
    // 望ましい挙動: 年額も（月割り or 支払月に）反映されること
    expect(f.rules).toEqual([{ amount: 5000, start_month: "2026-04", end_month: null }]);
  });

  it("データが空でも落ちず、期首残高だけの純資産を返す（境界）", async () => {
    const f = await getForecastInputs();
    expect(f.actuals).toEqual([]);
    expect(f.targets).toEqual([]);
    expect(f.rules).toEqual([]);
    expect(f.netAssets).toBe(520000);
  });
});
