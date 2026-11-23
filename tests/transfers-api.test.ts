// 振替API（/api/transfers の POST と /api/transfers/[id] の DELETE）。
//
// 既存テストは振替をSQL直INSERTで作っており、APIは一度も通っていなかった。
// ここではAPIハンドラを直接importして実際に叩き、
//   1. 振替がPL（収入/支出）に混入しないこと ＝ 黒字が水増しされないこと
//   2. 残高（総資産・純資産）が1円単位で正しく動くこと
//   3. 削除で残高が完全に元へ戻ること
// を金額のハードコードで確認する。
//
// 【現状記録】と書いたテストは「望ましい挙動」ではなく「今そうなっている事実」を
// 固定したもの。仕様バグとして bugs_found に報告済み。直したらこのテストも直すこと。
//
// 所有者検証（lib/ownership.ts）と fee_category_id の保存は修正済みなので、
// 該当テストは「正しい挙動を主張する」形に書き換えてある。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { POST } from "@/app/api/transfers/route";
import * as transferIdRoute from "@/app/api/transfers/[id]/route";
import { DELETE } from "@/app/api/transfers/[id]/route";
import { POST as settle } from "@/app/api/cards/settle/route";
import {
  getPLSummary,
  getAssets,
  getWalletBalances,
  getMonthTransfers,
} from "@/lib/queries";

let ids: Ids;

const PERIOD = "2026-09-01";
const DATE = "2026-09-15";

// ---- ヘルパ ----
const post = (b: unknown) =>
  POST(
    new Request("http://localhost/api/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })
  );

const del = (id: number | string) =>
  DELETE(new Request(`http://localhost/api/transfers/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  });

/** 既定は 銀行A → 現金 に 100,000 円 */
const body = (o: Record<string, unknown> = {}) => ({
  from_wallet_id: ids.wallet["銀行A"],
  to_wallet_id: ids.wallet["現金"],
  amount: 100000,
  transfer_date: DATE,
  ...o,
});

const nRows = async (): Promise<number> =>
  (await pool.query("SELECT count(*)::int AS n FROM transfers")).rows[0].n;

const allRows = async () =>
  (await pool.query("SELECT * FROM transfers ORDER BY id")).rows;

/** 残高0のウォレットは getWalletBalances から落ちるので 0 とみなす */
async function bal(name: string): Promise<number> {
  const b = await getWalletBalances();
  return b.find((x) => x.name === name)?.balance ?? 0;
}

/** ルートが例外を投げた場合も観測できる形で呼ぶ */
async function postCatching(b: unknown): Promise<{ res: Response | null; err: any }> {
  try {
    return { res: await post(b), err: null };
  } catch (e) {
    return { res: null, err: e };
  }
}

/** 別ユーザーとそのウォレット・費目を作る（所有者チェックの検証用） */
async function addOtherUser(): Promise<{
  userId: number;
  walletId: number;
  categoryId: number;
}> {
  const u = await pool.query(
    `INSERT INTO users (email, display_name, fiscal_year_start_month)
     VALUES ('other@example.com','他人',4) RETURNING id`
  );
  const userId: number = u.rows[0].id;
  const w = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets)
     VALUES ($1,'他人の銀行','bank',1000000,true) RETURNING id`,
    [userId]
  );
  const c = await pool.query(
    `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed)
     VALUES ($1,NULL,'他人の費目','variable_cost',true) RETURNING id`,
    [userId]
  );
  return { userId, walletId: w.rows[0].id, categoryId: c.rows[0].id };
}

/** 他人の残高を「自分のtransfersが混ざっていないか」まで含めて素で計算する */
async function rawBalance(userId: number, walletId: number): Promise<number> {
  const r = await pool.query(
    `SELECT (w.initial_balance
      + COALESCE((SELECT SUM(amount)     FROM transfers WHERE user_id=$1 AND to_wallet_id=w.id),0)
      - COALESCE((SELECT SUM(amount+fee) FROM transfers WHERE user_id=$1 AND from_wallet_id=w.id),0))::int AS b
     FROM wallets w WHERE w.id=$2`,
    [userId, walletId]
  );
  return r.rows[0].b;
}

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

// ============================================================
describe("振替はPL（損益）に混入しない", () => {
  // 期首: 銀行A 500,000 / 現金 20,000 / クレカA 0 → 総資産 520,000
  beforeEach(async () => {
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-09-25", wallet: "銀行A" });
    await addTx(ids, { category: "家賃", type: "expense", amount: 80000, date: "2026-09-05", wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 20000, date: "2026-09-10", wallet: "現金" });
  });

  it("4種類すべての資金移動を作ってもPLは1円も動かない", async () => {
    const before = await getPLSummary(PERIOD);
    expect(before).toMatchObject({ disposable: 300000, fixed: 80000, variable: 20000, surplus: 200000, excluded: 0 });

    // transfer / charge / cash_withdrawal / card_settlement を1件ずつ
    expect((await post(body({ kind: "transfer", amount: 10000 }))).status).toBe(200);
    expect((await post(body({ kind: "charge", amount: 3000, from_wallet_id: ids.wallet["現金"], to_wallet_id: ids.wallet["クレカA"] }))).status).toBe(200);
    expect((await post(body({ kind: "cash_withdrawal", amount: 5000 }))).status).toBe(200);
    expect((await post(body({ kind: "card_settlement", amount: 7000, to_wallet_id: ids.wallet["クレカA"], memo: "9月締め" }))).status).toBe(200);
    expect(await nRows()).toBe(4);

    // PLは完全に不変。ここが崩れると黒字が水増しされる。
    expect(await getPLSummary(PERIOD)).toEqual(before);
  });

  it("振替は残高だけを動かし、総資産・純資産は変わらない", async () => {
    // 取引だけの状態: 銀行A 500,000+300,000-80,000=720,000 / 現金 20,000-20,000=0
    expect(await bal("銀行A")).toBe(720000);
    const beforeAssets = await getAssets();
    expect(beforeAssets).toEqual({ total_assets: 720000, card_unpaid: 0, net_assets: 720000 });

    expect((await post(body({ amount: 100000 }))).status).toBe(200);

    expect(await bal("銀行A")).toBe(620000);
    expect(await bal("現金")).toBe(100000);
    // 口座間の付け替えなので総資産・純資産は不変
    expect(await getAssets()).toEqual({ total_assets: 720000, card_unpaid: 0, net_assets: 720000 });
  });
});

// ============================================================
describe("手数料(fee)", () => {
  it("feeは出金元から引かれる（入金先は amount のみ）", async () => {
    expect((await post(body({ amount: 100000, fee: 440 }))).status).toBe(200);

    expect(await bal("銀行A")).toBe(399560); // 500,000 - (100,000 + 440)
    expect(await bal("現金")).toBe(120000); // 20,000 + 100,000
    expect((await getAssets()).total_assets).toBe(519560); // 手数料440だけ資産が減る
  });

  // 以前: APIが fee_category_id を読み捨てていたので、列があるのに常にNULLだった。
  // 現在: リクエストの fee_category_id を保存する（ただし fee>0 のときだけ）。
  it("fee_category_idはリクエストから保存される（feeが0なら保存しない）", async () => {
    expect(
      (await post(body({ amount: 100000, fee: 440, fee_category_id: ids.cat["日用品"] }))).status
    ).toBe(200);

    const row = (await allRows())[0];
    expect(row.fee).toBe(440);
    // fee_category_id は bigint なので pg は文字列で返す
    expect(String(row.fee_category_id)).toBe(String(ids.cat["日用品"]));

    // 手数料が無いのに費目だけ残ると意味不明な行になるため、fee=0 ならNULL
    await pool.query("DELETE FROM transfers");
    expect(
      (await post(body({ amount: 100000, fee: 0, fee_category_id: ids.cat["日用品"] }))).status
    ).toBe(200);
    expect((await allRows())[0].fee_category_id).toBeNull();
  });

  // 【現状記録】望ましい挙動ではない。
  // fee_category_id は保存されるようになった（上のテスト）が、PL集計側は
  // どのクエリもこの列を読まない。fee は出金元から確かに引かれる（資産が440減る）のに
  // PL上はどこにも費用が立たず、手数料は「静かに消える支出」のまま。
  it("【現状記録】feeはPLに計上されない（費目を指定しても資産だけ減る）", async () => {
    const plBefore = await getPLSummary(PERIOD);
    const assetsBefore = (await getAssets()).total_assets;

    const res = await post(body({ amount: 100000, fee: 440, fee_category_id: ids.cat["日用品"] }));
    expect(res.status).toBe(200);
    // 費目はちゃんと記録されている。それでも集計に入らない、というのが問題の核心。
    expect(String((await allRows())[0].fee_category_id)).toBe(String(ids.cat["日用品"]));

    // 資産は440減っているのに、PLの費用は0のまま＝収支が440ぶん合わない
    expect((await getAssets()).total_assets).toBe(assetsBefore - 440);
    expect(await getPLSummary(PERIOD)).toEqual(plBefore);
  });

  // 【現状記録】望ましい挙動ではない。
  // 検証が Number.isInteger のみなので、小数や数値文字列の fee は黙って 0 に落ちる。
  // 400で弾きもせず、記録もしない＝入力した手数料がエラーも出さずに消える。
  it("【現状記録】小数・文字列のfeeは黙って0になる（400にもならない）", async () => {
    expect((await post(body({ amount: 100000, fee: 440.5 }))).status).toBe(200);
    expect((await allRows())[0].fee).toBe(0);
    expect(await bal("銀行A")).toBe(400000); // 手数料が引かれていない

    await pool.query("DELETE FROM transfers");
    expect((await post(body({ amount: 100000, fee: "440" }))).status).toBe(200);
    expect((await allRows())[0].fee).toBe(0);
  });

  it("負のfeeは0に丸められる（残高が増えることはない）", async () => {
    expect((await post(body({ amount: 100000, fee: -500 }))).status).toBe(200);
    expect((await allRows())[0].fee).toBe(0);
    expect(await bal("銀行A")).toBe(400000);
  });
});

// ============================================================
describe("入力検証", () => {
  it("同一ウォレット間の振替は400で拒否される", async () => {
    const res = await post(body({ to_wallet_id: ids.wallet["銀行A"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("同じ");
    expect(await nRows()).toBe(0);
  });

  it("【砦】アプリの検証をすり抜けてもDBのCHECK制約が同一ウォレットを止める", async () => {
    await expect(
      pool.query(
        `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, kind, transfer_date)
         VALUES ($1,$2,$2,1000,'transfer',$3)`,
        [ids.userId, ids.wallet["銀行A"], DATE]
      )
    ).rejects.toMatchObject({ code: "23514" });
    expect(await nRows()).toBe(0);
  });

  // 【現状記録】望ましい挙動ではない。
  // 同一ウォレット判定が `===`（型も一致）なので、片方が数値・片方が数値文字列だと
  // すり抜ける。結果、400ではなくDB例外（＝本番では500）になる。
  // 行は作られないので実害は「エラーの出方が汚い」で止まるが、入口の検証として不完全。
  it("【現状記録】from/toの型が違うと同一ウォレット判定をすり抜けDB例外になる", async () => {
    const same = ids.wallet["銀行A"];
    const { res, err } = await postCatching(
      body({ from_wallet_id: String(same), to_wallet_id: Number(same) })
    );
    expect(res).toBeNull();
    expect(err?.code).toBe("23514"); // アプリではなくDBが止めている
    expect(await nRows()).toBe(0);
  });

  it("amount<=0 / 必須項目欠落 / 不正kind は400で、1件も作られない", async () => {
    expect((await post(body({ amount: 0 }))).status).toBe(400);
    expect((await post(body({ amount: -100 }))).status).toBe(400);
    expect((await post(body({ from_wallet_id: undefined }))).status).toBe(400);
    expect((await post(body({ to_wallet_id: undefined }))).status).toBe(400);
    expect((await post(body({ transfer_date: undefined }))).status).toBe(400);
    expect((await post(body({ kind: "withdrawal" }))).status).toBe(400);
    expect((await post(body({ kind: "" }))).status).toBe(400);
    expect(await nRows()).toBe(0);
  });

  it("JSONが壊れていれば400", async () => {
    const res = await POST(
      new Request("http://localhost/api/transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{壊れたJSON",
      })
    );
    expect(res.status).toBe(400);
    expect(await nRows()).toBe(0);
  });

  // 【現状記録】望ましい挙動ではない。
  // amount は fee と違って整数チェックが無いため、小数がそのままDBへ渡りDB例外になる。
  // （feeは黙って0、amountは例外。同じ金額項目なのに扱いがバラバラ）
  it("【現状記録】小数のamountは400にならずDB例外になる", async () => {
    const { res, err } = await postCatching(body({ amount: 100.5 }));
    expect(res).toBeNull();
    expect(err?.code).toBe("22P02"); // invalid input syntax for type integer
    expect(await nRows()).toBe(0);
  });

  it("数値文字列のamountは受理され、整数として保存される", async () => {
    expect((await post(body({ amount: "5000" }))).status).toBe(200);
    expect((await allRows())[0].amount).toBe(5000);
    expect(await bal("銀行A")).toBe(495000);
  });

  // 以前: FK違反(23503)のDB例外が素通りし、本番では500になっていた。
  // 現在: 所有者検証(lib/ownership.ts)が入口で弾くので400。
  it("存在しないウォレットIDは400で弾かれる（DB例外にならない）", async () => {
    for (const patch of [{ to_wallet_id: 999999 }, { from_wallet_id: 999999 }]) {
      const { res, err } = await postCatching(body(patch));
      expect(err).toBeNull();
      expect(res!.status).toBe(400);
      expect((await res!.json()).error).toContain("指定された決済手段が見つかりません");
    }
    expect(await nRows()).toBe(0);
  });
});

// ============================================================
describe("ウォレットの所有者チェック", () => {
  // 以前: POSTは from/to が自分のウォレットか一切確認せず、他人の口座を出金元に
  // 指定すると「自分の入金だけが記録され、出金は誰の残高からも引かれない」＝
  // 総資産が無から増えた。セルフサインアップ開放（ADR-053）でIDは推測可能なので実害があった。
  // 現在: lib/ownership.ts の checkRefs が400で弾く。
  it("他人のウォレットを出金元にした振替は400で拒否される（総資産は増えない）", async () => {
    const other = await addOtherUser();
    const before = await getAssets();
    expect(before.total_assets).toBe(520000);

    const res = await post(body({ from_wallet_id: other.walletId, amount: 50000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("指定された決済手段が見つかりません");

    // 行は1件も作られず、自分の残高・総資産は1円も動かない
    expect(await nRows()).toBe(0);
    expect(await getAssets()).toEqual(before);
    expect(await bal("銀行A")).toBe(500000);
    expect(await bal("現金")).toBe(20000);
    // 他人の残高ももちろん無傷
    expect(await rawBalance(other.userId, other.walletId)).toBe(1000000);
  });

  it("他人のウォレットを入金先にした振替も400で拒否される", async () => {
    const other = await addOtherUser();
    const res = await post(body({ to_wallet_id: other.walletId, amount: 50000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("指定された決済手段が見つかりません");
    expect(await nRows()).toBe(0);
    expect(await bal("銀行A")).toBe(500000);
  });

  // 以前: 作成が通ってしまうため、一覧に他ユーザーのウォレット名が出て情報が漏れていた。
  it("他人のウォレット名は振替一覧に漏れない（作成自体が拒否されるため）", async () => {
    const other = await addOtherUser();
    expect((await post(body({ from_wallet_id: other.walletId, amount: 50000 }))).status).toBe(400);

    expect(await getMonthTransfers(PERIOD)).toHaveLength(0);
  });

  // fee_category_id も同じ検証を通る（費目側のエラー文言は別）
  it("他人の費目・存在しない費目を fee_category_id に指定すると400", async () => {
    const other = await addOtherUser();

    for (const cid of [other.categoryId, 999999]) {
      const res = await post(body({ amount: 100000, fee: 440, fee_category_id: cid }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("指定された費目が見つかりません");
    }
    expect(await nRows()).toBe(0);
    expect(await bal("銀行A")).toBe(500000);
  });
});

// ============================================================
describe("削除", () => {
  it("削除すると残高が完全に元へ戻る（手数料ぶんも含めて）", async () => {
    const res = await post(body({ amount: 100000, fee: 440 }));
    const { id } = await res.json();
    expect(await bal("銀行A")).toBe(399560);

    const d = await del(id);
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ ok: true, deleted: 1 });

    expect(await bal("銀行A")).toBe(500000);
    expect(await bal("現金")).toBe(20000);
    expect(await getAssets()).toEqual({ total_assets: 520000, card_unpaid: 0, net_assets: 520000 });
    expect(await getMonthTransfers(PERIOD)).toHaveLength(0);
    expect(await nRows()).toBe(0);
  });

  it("他ユーザーの振替は削除できない（404・行は残る）", async () => {
    const other = await addOtherUser();
    const r = await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, kind, transfer_date)
       VALUES ($1,$2,$3,30000,'transfer',$4) RETURNING id`,
      [other.userId, other.walletId, ids.wallet["現金"], DATE]
    );
    const res = await del(r.rows[0].id);
    expect(res.status).toBe(404);
    expect(await nRows()).toBe(1);
  });

  it("存在しないIDは404、不正なIDは400", async () => {
    expect((await del(999999)).status).toBe(404);
    expect((await del("abc")).status).toBe(400);
    expect((await del(0)).status).toBe(400);
    expect((await del(-1)).status).toBe(400);
  });

  // 【現状記録】望ましい挙動ではない（少なくとも要確認）。
  // 振替の「更新」APIは存在しない。金額を間違えたら削除→再作成しかない。
  // 更新経路が無いぶん残高がズレるリスクは無いが、UIにも編集手段が無い。
  it("【現状記録】更新API（PUT/PATCH）は実装されていない", () => {
    expect("PUT" in transferIdRoute).toBe(false);
    expect("PATCH" in transferIdRoute).toBe(false);
    expect(typeof transferIdRoute.DELETE).toBe("function");
  });
});

// ============================================================
describe("二重登録", () => {
  // 【現状記録】望ましい挙動ではない。
  // transactions には client_key（冪等キー / ADR-040）があるが、transfers には無い。
  // 保存ボタンの二度押しや通信リトライで、同額の振替がそのまま2件作られる。
  it("【現状記録】同じ内容を2回POSTすると2件作られ、残高が二重に引かれる", async () => {
    const r1 = await post(body({ amount: 100000, memo: "生活費移動" }));
    const r2 = await post(body({ amount: 100000, memo: "生活費移動" }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await r1.json()).id).not.toBe((await r2.json()).id);

    expect(await nRows()).toBe(2);
    expect(await bal("銀行A")).toBe(300000); // 500,000 - 100,000 x2
    expect(await bal("現金")).toBe(220000);

    // 冪等キーを受け取る列自体が無い
    const cols = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='transfers'`
      )
    ).rows.map((r) => r.column_name);
    expect(cols).not.toContain("client_key");
  });

  // 【現状記録】望ましい挙動ではない。
  // uq_card_settlement は (user_id, to_wallet_id, memo) の部分ユニーク索引だが、
  // PostgreSQLではNULLは互いに重複扱いされない。汎用の振替APIは memo 未指定でも
  // kind='card_settlement' を作れるので、カード消込の二重登録防止をすり抜ける。
  it("【現状記録】memo無しのcard_settlementは索引をすり抜けて二重に作れる", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
    const b = { from_wallet_id: ids.wallet["銀行A"], to_wallet_id: ids.wallet["クレカA"], amount: 30000, transfer_date: "2026-10-10", kind: "card_settlement" };

    expect((await post(b)).status).toBe(200);
    expect((await post(b)).status).toBe(200); // memoがNULLなのでユニーク索引が効かない
    expect(await nRows()).toBe(2);

    // 銀行から60,000引かれ、カードは30,000の過払い状態になる
    expect(await bal("銀行A")).toBe(440000);
    expect(await bal("クレカA")).toBe(30000);
    const a = await getAssets();
    expect(a.total_assets).toBe(460000);
    expect(a.card_unpaid).toBe(-30000); // 未払いがマイナス＝過払い
  });

  // 【現状記録】望ましい挙動ではない。
  // 汎用の振替APIから手でカード支払いを作ると、/api/cards/settle の重複チェック
  // （memoの締めキー一致で判定）に引っかからず、同じ締めサイクルが二重に落ちる。
  it("【現状記録】手動のcard_settlementは/api/cards/settleの重複判定をすり抜ける", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });

    // ユーザーが振替画面から「カード支払い」を手入力
    expect(
      (await post({
        from_wallet_id: ids.wallet["銀行A"],
        to_wallet_id: ids.wallet["クレカA"],
        amount: 30000,
        transfer_date: "2026-10-10",
        kind: "card_settlement",
        memo: "10月の引き落とし",
      })).status
    ).toBe(200);

    // カード画面から消し込むと、memoが違うので重複と判定されず通ってしまう
    const s = await settle(
      new Request("http://localhost/api/cards/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          card_id: ids.wallet["クレカA"],
          close_key: "2026-09-15",
          amount: 30000,
          pay_date: "2026-10-10",
        }),
      })
    );
    expect(s.status).toBe(200);

    expect(await nRows()).toBe(2);
    expect(await bal("銀行A")).toBe(440000); // 30,000の請求に対し60,000引かれている
    expect((await getAssets()).card_unpaid).toBe(-30000);
  });
});

// ============================================================
describe("kindの扱い と getMonthTransfers", () => {
  it("残高計算はkindを見ていない（transferでもカード未払いが減る）", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
    expect((await getAssets()).card_unpaid).toBe(30000);

    // kind='transfer' でも card_settlement と同じように未払いが消える＝kindは表示用ラベル
    expect(
      (await post({
        from_wallet_id: ids.wallet["銀行A"],
        to_wallet_id: ids.wallet["クレカA"],
        amount: 30000,
        transfer_date: "2026-10-10",
        kind: "transfer",
      })).status
    ).toBe(200);

    const a = await getAssets();
    expect(a.card_unpaid).toBe(0);
    expect(a.total_assets).toBe(490000);
  });

  it("getMonthTransfers は当月のものだけを返す（月境界）", async () => {
    for (const d of ["2026-08-31", "2026-09-01", "2026-09-30", "2026-10-01"]) {
      expect((await post(body({ amount: 1000, transfer_date: d }))).status).toBe(200);
    }
    const rows = await getMonthTransfers(PERIOD);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-30", "2026-09-01"]); // 日付降順
  });

  it("getMonthTransfers は他ユーザーの振替を返さない", async () => {
    const other = await addOtherUser();
    await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, kind, transfer_date)
       VALUES ($1,$2,$3,30000,'transfer',$4)`,
      [other.userId, other.walletId, ids.wallet["現金"], DATE]
    );
    await post(body({ amount: 7000 }));

    const rows = await getMonthTransfers(PERIOD);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(7000);
  });

  it("【クロス検証】一覧の amount+fee の合計 ＝ 銀行Aの残高の減少額", async () => {
    await post(body({ amount: 30000, fee: 220, kind: "transfer" }));
    await post(body({ amount: 10000, fee: 0, kind: "cash_withdrawal" }));
    await post(body({ amount: 5000, fee: 110, kind: "charge", to_wallet_id: ids.wallet["クレカA"] }));
    // 銀行Aが入金先になる振替（差額の符号を取り違えていないかの確認）
    await post(body({ amount: 2000, from_wallet_id: ids.wallet["現金"], to_wallet_id: ids.wallet["銀行A"] }));

    const rows = await getMonthTransfers(PERIOD);
    expect(rows).toHaveLength(4);

    const out = rows
      .filter((r) => r.from_name === "銀行A")
      .reduce((s, r) => s + r.amount + r.fee, 0);
    const inn = rows
      .filter((r) => r.to_name === "銀行A")
      .reduce((s, r) => s + r.amount, 0);
    expect(out).toBe(45330); // 30,220 + 10,000 + 5,110
    expect(inn).toBe(2000);

    expect(await bal("銀行A")).toBe(500000 - out + inn); // 456,670
    expect(await bal("銀行A")).toBe(456670);
    expect(await bal("現金")).toBe(58000); // 20,000 +30,000 +10,000 -2,000
    expect(await bal("クレカA")).toBe(5000); // チャージぶんカード残高がプラスに

    const a = await getAssets();
    // クレカは総資産に含まれないので、チャージした5,000は総資産から出ていく
    expect(a.total_assets).toBe(514670); // 456,670 + 58,000
    // 純資産は手数料330だけ減る。手数料は誰の資産にも入らず消えるが、PLにも載らない。
    expect(a.net_assets).toBe(519670); // 520,000 - 330
  });

  it("一覧はkind・メモ・手数料をそのまま返す", async () => {
    await post(body({ amount: 12345, fee: 55, kind: "charge", memo: "PASMOチャージ", to_wallet_id: ids.wallet["クレカA"] }));
    const rows = await getMonthTransfers(PERIOD);
    expect(rows[0]).toMatchObject({
      date: DATE,
      kind: "charge",
      amount: 12345,
      fee: 55,
      memo: "PASMOチャージ",
      from_name: "銀行A",
      to_name: "クレカA",
    });
  });
});
