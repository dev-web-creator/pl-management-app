// 取引削除とその他API（設定 / ビジョン / 通知ルール / エクスポート / ヘルス）。
//
// このファイルの狙い:
//  1. 削除で「脚（transaction_legs）」が確実に道連れになり、残高とPLが元に戻ること。
//     取引だけ消えて脚が残ると、PLからは消えたのに残高だけ減ったままになる（静かな不整合）。
//  2. /api/export/all はユーザーにとって唯一のバックアップ手段。テーブルの取りこぼしは
//     「バックアップしたつもりで消える」事故になるため、DBの実テーブル一覧と突合する。
//  3. 他人のデータに触れないこと（user_idガード）。
//
// 注意: 期待値は手計算でハードコードする。「落ちないこと」だけのテストは書かない。
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import pool, { ensureMigrated } from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { DELETE as delTx } from "@/app/api/transactions/[id]/route";
import { PUT as putSettings } from "@/app/api/settings/route";
import { POST as postVision } from "@/app/api/vision/route";
import { POST as postRule } from "@/app/api/notification-rules/route";
import {
  PUT as putRule,
  DELETE as delRule,
} from "@/app/api/notification-rules/[id]/route";
import { GET as exportAll } from "@/app/api/export/all/route";
import { GET as exportTx } from "@/app/api/export/transactions/route";
import { GET as health } from "@/app/api/health/route";
import { notifyEnabled } from "@/lib/notify";
import {
  getTransactionForEdit,
  getUserSettings,
  getHiddenPages,
  hasNoTransactions,
  getVisionNote,
  getNotificationRules,
  getNotificationLog,
  getUserFyStartMonth,
  getPLSummary,
  getAssets,
} from "@/lib/queries";

let ids: Ids;

// ---- ルート呼び出しのショートカット ----
const del = (id: number | string) =>
  delTx(new Request(`http://localhost/api/transactions/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  });

const jsonReq = (url: string, method: string, body: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const settings = (b: unknown) =>
  putSettings(jsonReq("http://localhost/api/settings", "PUT", b));
const vision = (b: unknown) =>
  postVision(jsonReq("http://localhost/api/vision", "POST", b));
const newRule = (b: unknown) =>
  postRule(jsonReq("http://localhost/api/notification-rules", "POST", b));
const toggleRule = (id: number | string, b: unknown) =>
  putRule(jsonReq(`http://localhost/api/notification-rules/${id}`, "PUT", b), {
    params: Promise.resolve({ id: String(id) }),
  });
const removeRule = (id: number | string) =>
  delRule(new Request(`http://localhost/api/notification-rules/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  });

// ---- 補助 ----
const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await pool.query(sql, params)).rows[0].n;

const legCount = () => count("SELECT count(*)::int AS n FROM transaction_legs");

/** 他人（user_id=2）のデータ一式。user_idガードの検証に使う。 */
async function addOtherUser() {
  const u = await pool.query(
    `INSERT INTO users (email, display_name) VALUES ('other@example.com','他人') RETURNING id`
  );
  const userId: number = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO categories (user_id, name, pl_type, is_input_allowed)
     VALUES ($1,'他人の食費','variable_cost',true) RETURNING id`,
    [userId]
  );
  const w = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets)
     VALUES ($1,'他人の銀行','bank',100000,true) RETURNING id`,
    [userId]
  );
  const t = await pool.query(
    `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date, memo)
     VALUES ($1,$2,'expense',9999,'2026-09-09','他人のメモ') RETURNING id`,
    [userId, c.rows[0].id]
  );
  await pool.query(
    `INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,9999)`,
    [t.rows[0].id, w.rows[0].id]
  );
  const r = await pool.query(
    `INSERT INTO notification_rules (user_id, kind, threshold)
     VALUES ($1,'variable_cost_threshold',777) RETURNING id`,
    [userId]
  );
  await pool.query(
    `INSERT INTO vision_notes (user_id, content) VALUES ($1,'他人のビジョン')`,
    [userId]
  );
  return {
    userId,
    txId: Number(t.rows[0].id),
    walletId: Number(w.rows[0].id),
    catId: Number(c.rows[0].id),
    ruleId: Number(r.rows[0].id),
  };
}

beforeAll(async () => {
  // オートマイグレーションは「プロセス内で1回だけ」memo化される。既定の通知ルール5件の
  // 投入もその中にあるため、最初の resetDb より前に走らせておかないと、
  // テストの実行順で notification_rules の初期状態が変わってしまう。
  // ここで先に消化しておき、各テストは「ルール0件」から始まることを保証する。
  await ensureMigrated();
});
beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

// ============================================================
// 1. 取引削除（DELETE /api/transactions/[id]）
// ============================================================
describe("取引削除", () => {
  beforeEach(async () => {
    // 手計算できる最小セット
    //   銀行A 期首 500,000 / 現金 期首 20,000 / クレカA 0
    //   tx1 食料品 支出 12,345 (銀行A)
    //   tx2 外食   支出  6,789 (現金)
    //   tx3 給与   収入 250,000 (銀行A)
    await addTx(ids, { category: "食料品", type: "expense", amount: 12345, date: "2026-09-05", wallet: "銀行A" });
    await addTx(ids, { category: "外食", type: "expense", amount: 6789, date: "2026-09-07", wallet: "現金" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 250000, date: "2026-09-25", wallet: "銀行A" });
  });

  it("削除すると脚もCASCADEで消え、残高とPLがぴったり戻る", async () => {
    const before = await getPLSummary("2026-09-01");
    expect(before).toMatchObject({
      disposable: 250000,
      fixed: 0,
      variable: 19134, // 12,345 + 6,789
      surplus: 230866, // 250,000 - 19,134
    });
    const a0 = await getAssets();
    // 銀行A = 500,000 - 12,345 + 250,000 = 737,655 / 現金 = 20,000 - 6,789 = 13,211
    expect(a0.total_assets).toBe(750866);
    expect(a0.card_unpaid).toBe(0);
    expect(await legCount()).toBe(3);

    const txId = (await pool.query(
      `SELECT id FROM transactions WHERE amount=12345`
    )).rows[0].id as number;

    const res = await del(txId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 1 });

    // 脚が道連れになっている（取引だけ消えて脚が残ると残高だけズレる）
    expect(await legCount()).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM transactions`)).toBe(2);

    const after = await getPLSummary("2026-09-01");
    expect(after).toMatchObject({
      disposable: 250000,
      fixed: 0,
      variable: 6789,
      surplus: 243211,
    });
    const a1 = await getAssets();
    expect(a1.total_assets).toBe(763211); // 750,866 + 12,345
    expect(a1.net_assets).toBe(763211);
  });

  it("分割払い（脚2本）の取引を消すと脚が2本とも消える", async () => {
    // 30,000 を 銀行A 20,000 + 現金 10,000 で支払った取引
    const r = await pool.query(
      `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date)
       VALUES ($1,$2,'expense',30000,'2026-09-12') RETURNING id`,
      [ids.userId, ids.cat["日用品"]]
    );
    const splitId = Number(r.rows[0].id);
    await pool.query(
      `INSERT INTO transaction_legs (transaction_id, wallet_id, amount)
       VALUES ($1,$2,20000),($1,$3,10000)`,
      [splitId, ids.wallet["銀行A"], ids.wallet["現金"]]
    );
    expect(await legCount()).toBe(5);
    const beforeAssets = (await getAssets()).total_assets;
    expect(beforeAssets).toBe(720866); // 750,866 - 30,000

    expect((await del(splitId)).status).toBe(200);

    expect(await legCount()).toBe(3);
    expect(
      await count(`SELECT count(*)::int AS n FROM transaction_legs WHERE transaction_id=$1`, [splitId])
    ).toBe(0);
    expect((await getAssets()).total_assets).toBe(750866); // 満額戻る
  });

  it("存在しないIDは404で、他の取引は1件も消えない", async () => {
    const res = await del(999999);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not found" });
    expect(await count(`SELECT count(*)::int AS n FROM transactions`)).toBe(3);
  });

  it("同じIDを2回消すと、2回目は404（多重削除で他の行を巻き込まない）", async () => {
    const txId = (await pool.query(`SELECT id FROM transactions ORDER BY id LIMIT 1`)).rows[0].id as number;
    expect((await del(txId)).status).toBe(200);
    expect((await del(txId)).status).toBe(404);
    expect(await count(`SELECT count(*)::int AS n FROM transactions`)).toBe(2);
  });

  it("不正なIDは400（DELETEを一切走らせない）", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", "", "null", "1,2"]) {
      const res = await del(bad);
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    expect(await count(`SELECT count(*)::int AS n FROM transactions`)).toBe(3);
  });

  it("【現状の記録】Number()の寛容さで '1e3' や ' 3 ' もIDとして通る（該当行が無いので404）", async () => {
    // 望ましい挙動ではない（/api/transactions/1e3 が id=1000 の削除になりうる）。
    // 実害は小さいが、意図しないIDに当たる可能性があるので記録しておく。
    expect((await del("1e3")).status).toBe(404); // Number('1e3') = 1000
    const third = (await pool.query(`SELECT id FROM transactions ORDER BY id`)).rows[2].id;
    expect((await del(` ${third} `)).status).toBe(200); // 前後の空白が無視される
    expect(await count(`SELECT count(*)::int AS n FROM transactions`)).toBe(2);
  });

  it("他人の取引は削除できない（404で、相手の行も脚もそのまま）", async () => {
    const other = await addOtherUser();
    const res = await del(other.txId);
    expect(res.status).toBe(404);
    expect(
      await count(`SELECT count(*)::int AS n FROM transactions WHERE id=$1`, [other.txId])
    ).toBe(1);
    expect(
      await count(`SELECT count(*)::int AS n FROM transaction_legs WHERE transaction_id=$1`, [other.txId])
    ).toBe(1);
  });

  it("【現状の記録】消込済みのカード利用を削除すると、カード未払いがマイナスになり純資産＞総資産になる", async () => {
    // 望ましい挙動ではない（銀行からの引き落としは残るのに利用明細だけ消えるため、
    // ¥30,000 が「カードの預け金」として総資産からは外れ、純資産にだけ乗る）。
    // 削除時に消込済みかどうかを警告する／消込を巻き戻す手当てが無いことの記録。
    const chargeId = await addTx(ids, {
      category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA",
    });
    await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, transfer_date, kind, memo)
       VALUES ($1,$2,$3,30000,'2026-10-10','card_settlement','クレカ消込:2026-09-15締め')`,
      [ids.userId, ids.wallet["銀行A"], ids.wallet["クレカA"]]
    );
    const settled = await getAssets();
    // 銀行A 737,655-30,000=707,655 / 現金 13,211 / クレカA 0
    expect(settled).toEqual({ total_assets: 720866, card_unpaid: 0, net_assets: 720866 });

    expect((await del(chargeId)).status).toBe(200);

    const after = await getAssets();
    expect(after.card_unpaid).toBe(-30000); // マイナスの「未払い」が表示される
    expect(after.total_assets).toBe(720866); // 総資産は戻らない
    expect(after.net_assets).toBe(750866); // 純資産だけ 30,000 増える
    expect(after.net_assets).toBeGreaterThan(after.total_assets);
  });

  it("削除しても他人の残高・PLには影響しない", async () => {
    const other = await addOtherUser();
    const txId = (await pool.query(`SELECT id FROM transactions WHERE amount=6789`)).rows[0].id as number;
    expect((await del(txId)).status).toBe(200);
    // 他人の取引はそのまま
    expect(
      await count(`SELECT count(*)::int AS n FROM transactions WHERE user_id=$1`, [other.userId])
    ).toBe(1);
  });
});

// ============================================================
// 2. getTransactionForEdit（編集画面が読む1件）
// ============================================================
describe("getTransactionForEdit", () => {
  it("単一脚: 金額・日付・カテゴリ・ウォレット・leg_count=1 を返す", async () => {
    const id = await addTx(ids, {
      category: "外食", type: "expense", amount: 4800, date: "2026-09-18", wallet: "現金", memo: "ランチ",
    });
    const t = await getTransactionForEdit(id);
    expect(t).not.toBeNull();
    // id/category_id/wallet_id は bigint のため pg は文字列で返す。数値化して比較する。
    expect(Number(t!.id)).toBe(Number(id));
    expect(Number(t!.category_id)).toBe(Number(ids.cat["外食"]));
    expect(Number(t!.wallet_id)).toBe(Number(ids.wallet["現金"]));
    expect(t!.type).toBe("expense");
    expect(t!.amount).toBe(4800);
    expect(t!.date).toBe("2026-09-18");
    expect(t!.memo).toBe("ランチ");
    expect(t!.leg_count).toBe(1);
  });

  it("脚なし取引（インポート由来）は wallet_id=null / leg_count=0", async () => {
    const id = await addTx(ids, { category: "家賃", type: "expense", amount: 129987, date: "2026-08-01" });
    const t = await getTransactionForEdit(id);
    expect(t!.wallet_id).toBeNull();
    expect(t!.leg_count).toBe(0);
    expect(t!.amount).toBe(129987);
  });

  it("分割払いは先頭脚のウォレットを返し leg_count=2（総額は取引側の金額）", async () => {
    const r = await pool.query(
      `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date)
       VALUES ($1,$2,'expense',30000,'2026-09-12') RETURNING id`,
      [ids.userId, ids.cat["日用品"]]
    );
    const id = Number(r.rows[0].id);
    await pool.query(
      `INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,20000)`,
      [id, ids.wallet["銀行A"]]
    );
    await pool.query(
      `INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,10000)`,
      [id, ids.wallet["現金"]]
    );
    const t = await getTransactionForEdit(id);
    expect(t!.leg_count).toBe(2);
    expect(Number(t!.wallet_id)).toBe(Number(ids.wallet["銀行A"])); // id昇順の先頭
    expect(t!.amount).toBe(30000); // 脚の合計 20,000+10,000 と一致
  });

  it("他人の取引は null（編集画面から覗けない）", async () => {
    const other = await addOtherUser();
    expect(await getTransactionForEdit(other.txId)).toBeNull();
  });

  it("削除済み / 存在しないIDは null", async () => {
    const id = await addTx(ids, { category: "食料品", type: "expense", amount: 500, date: "2026-09-01" });
    expect(await getTransactionForEdit(id)).not.toBeNull();
    await del(id);
    expect(await getTransactionForEdit(id)).toBeNull();
    expect(await getTransactionForEdit(999999)).toBeNull();
  });
});

// ============================================================
// 3. 設定（PUT /api/settings）
// ============================================================
describe("設定 PUT /api/settings", () => {
  it("FY開始月を保存でき、2つの読み出し口が同じ値を返す", async () => {
    expect((await getUserSettings()).fiscal_year_start_month).toBe(4);
    const res = await settings({ fiscal_year_start_month: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect((await getUserSettings()).fiscal_year_start_month).toBe(7);
    expect(await getUserFyStartMonth()).toBe(7); // /year が読む方の口とも一致
  });

  it("非表示ページを保存でき、ナビ用の読み出しに反映される", async () => {
    expect(await getHiddenPages()).toEqual([]);
    const res = await settings({ hidden_pages: ["/weekly", "/inspect"] });
    expect(res.status).toBe(200);
    expect(await getHiddenPages()).toEqual(["/weekly", "/inspect"]);
    expect((await getUserSettings()).hidden_pages).toEqual(["/weekly", "/inspect"]);

    // 空配列で全復元できる（隠しっぱなしにならない）
    await settings({ hidden_pages: [] });
    expect(await getHiddenPages()).toEqual([]);
  });

  it("部分更新: hidden_pages だけ送ってもFY開始月は巻き戻らない", async () => {
    await settings({ fiscal_year_start_month: 10 });
    await settings({ hidden_pages: ["/vision"] });
    const s = await getUserSettings();
    expect(s.fiscal_year_start_month).toBe(10);
    expect(s.hidden_pages).toEqual(["/vision"]);
  });

  it("範囲外のFY開始月は400で、保存済みの値を壊さない", async () => {
    await settings({ fiscal_year_start_month: 7 });
    for (const bad of [0, 13, -1, 1.5, "abc", null]) {
      const res = await settings({ fiscal_year_start_month: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    expect(await getUserFyStartMonth()).toBe(7);
  });

  it("許可リスト外のhrefは400（常時表示の / と /settings も隠せない）", async () => {
    for (const bad of [["/"], ["/settings"], ["/nope"], ["/weekly", "/"], "notarray", [1]]) {
      const res = await settings({ hidden_pages: bad });
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect(await getHiddenPages()).toEqual([]);
  });

  it("【現状の記録】Number()の寛容さで true / ['7'] / '07' もFY開始月として通る", async () => {
    // 望ましい挙動ではない（true が 1月、['7'] が 7月として保存される）。
    // 型チェックなしで Number() に渡しているため、フォーム以外からの誤送信を弾けない。
    expect((await settings({ fiscal_year_start_month: true })).status).toBe(200);
    expect(await getUserFyStartMonth()).toBe(1); // Number(true) = 1
    expect((await settings({ fiscal_year_start_month: ["7"] })).status).toBe(200);
    expect(await getUserFyStartMonth()).toBe(7); // Number(['7']) = 7
    expect((await settings({ fiscal_year_start_month: "07" })).status).toBe(200);
    expect(await getUserFyStartMonth()).toBe(7);
  });

  it("更新項目が無いボディ / 壊れたJSON は400", async () => {
    expect((await settings({})).status).toBe(400);
    const broken = await putSettings(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );
    expect(broken.status).toBe(400);
  });

  it("設定変更は他人のユーザー行に波及しない", async () => {
    const other = await addOtherUser();
    await settings({ fiscal_year_start_month: 12, hidden_pages: ["/weekly"] });
    const o = await pool.query(
      `SELECT fiscal_year_start_month, hidden_pages FROM users WHERE id=$1`,
      [other.userId]
    );
    expect(o.rows[0].fiscal_year_start_month).toBe(4);
    expect(o.rows[0].hidden_pages).toEqual([]);
  });
});

// ============================================================
// 4. ビジョン（POST /api/vision）
// ============================================================
describe("ビジョン POST /api/vision", () => {
  it("保存でき、2回目は上書き（行は1件のまま）", async () => {
    expect(await getVisionNote()).toBe("");
    expect((await vision({ content: "1年で純資産1,000万円" })).status).toBe(200);
    expect(await getVisionNote()).toBe("1年で純資産1,000万円");

    expect((await vision({ content: "書き換え後" })).status).toBe(200);
    expect(await getVisionNote()).toBe("書き換え後");
    expect(await count(`SELECT count(*)::int AS n FROM vision_notes WHERE user_id=$1`, [ids.userId])).toBe(1);
  });

  it("【現状の記録】content を省いたPOSTは400ではなく空文字で上書きし、保存済みの本文が消える", async () => {
    // 望ましい挙動ではない。content 未指定は 400 で弾き、既存の本文を守るべき。
    // ここでは現状を固定して bugs_found に報告する。
    await vision({ content: "消えてほしくない目標" });
    const res = await vision({});
    expect(res.status).toBe(200);
    expect(await getVisionNote()).toBe(""); // ← 本文が消えている
  });

  it("壊れたJSONは400で、保存済みの本文は無傷", async () => {
    await vision({ content: "守られるべき本文" });
    const res = await postVision(
      new Request("http://localhost/api/vision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );
    expect(res.status).toBe(400);
    expect(await getVisionNote()).toBe("守られるべき本文");
  });

  it("他人のビジョンは読めないし上書きもしない", async () => {
    const other = await addOtherUser();
    await vision({ content: "自分のビジョン" });
    expect(await getVisionNote()).toBe("自分のビジョン");
    const o = await pool.query(`SELECT content FROM vision_notes WHERE user_id=$1`, [other.userId]);
    expect(o.rows[0].content).toBe("他人のビジョン");
  });
});

// ============================================================
// 5. 通知ルール（CRUD）— メール送信は絶対に起こさない
// ============================================================
describe("通知ルール", () => {
  it("メール送信は無効（RESEND_API_KEY未設定）", () => {
    expect(notifyEnabled()).toBe(false);
  });

  it("追加→一覧（threshold昇順）。同じしきい値の2件目は409", async () => {
    expect(await getNotificationRules()).toEqual([]);

    expect((await newRule({ threshold: 200000 })).status).toBe(200);
    expect((await newRule({ threshold: 100000 })).status).toBe(200);

    const rules = await getNotificationRules();
    expect(rules.map((r) => r.threshold)).toEqual([100000, 200000]); // kind, threshold 順
    expect(rules.every((r) => r.enabled)).toBe(true);
    expect(rules.every((r) => r.kind === "variable_cost_threshold")).toBe(true);

    const dup = await newRule({ threshold: 100000 });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toContain("既にあります");
    expect(await getNotificationRules()).toHaveLength(2);

    // メールは1通も発生していない
    expect(await count(`SELECT count(*)::int AS n FROM notification_log`)).toBe(0);
  });

  it("不正なしきい値は400（行は増えない）", async () => {
    for (const bad of [0, -1, 1.5, "abc", null, undefined]) {
      const res = await newRule({ threshold: bad });
      expect([String(bad), res.status]).toEqual([String(bad), 400]);
    }
    expect(await getNotificationRules()).toEqual([]);
  });

  it("ON/OFFを切り替えられる。存在しないIDは404", async () => {
    const id = (await (await newRule({ threshold: 150000 })).json()).id as number;
    expect((await toggleRule(id, { enabled: false })).status).toBe(200);
    expect((await getNotificationRules())[0].enabled).toBe(false);
    expect((await toggleRule(id, { enabled: true })).status).toBe(200);
    expect((await getNotificationRules())[0].enabled).toBe(true);

    expect((await toggleRule(999999, { enabled: false })).status).toBe(404);
    expect((await toggleRule(id, { enabled: "yes" })).status).toBe(400);
    expect((await toggleRule("abc", { enabled: false })).status).toBe(400);
  });

  it("削除すると送信履歴もCASCADEで消える", async () => {
    const id = (await (await newRule({ threshold: 250000 })).json()).id as number;
    await pool.query(
      `INSERT INTO notification_log (user_id, rule_id, period, sent_to, detail)
       VALUES ($1,$2,'2026-09-01','me@example.com','variable_total=260000')`,
      [ids.userId, id]
    );
    expect(await count(`SELECT count(*)::int AS n FROM notification_log`)).toBe(1);

    expect((await removeRule(id)).status).toBe(200);
    expect(await getNotificationRules()).toEqual([]);
    expect(await count(`SELECT count(*)::int AS n FROM notification_log`)).toBe(0);
    expect((await removeRule(id)).status).toBe(404); // 2回目
  });

  it("他人のルールはON/OFFも削除もできない（404・相手の行は無傷）", async () => {
    const other = await addOtherUser();
    expect((await toggleRule(other.ruleId, { enabled: false })).status).toBe(404);
    expect((await removeRule(other.ruleId)).status).toBe(404);
    const o = await pool.query(
      `SELECT threshold, enabled FROM notification_rules WHERE id=$1`,
      [other.ruleId]
    );
    expect(o.rows[0]).toEqual({ threshold: 777, enabled: true });
  });

  it("送信履歴の一覧は新しい順・limit付きで、しきい値と対象月が取れる", async () => {
    const a = (await (await newRule({ threshold: 100000 })).json()).id as number;
    const b = (await (await newRule({ threshold: 200000 })).json()).id as number;
    await pool.query(
      `INSERT INTO notification_log (user_id, rule_id, period, sent_to, sent_at)
       VALUES ($1,$2,'2026-07-01','me@example.com','2026-07-05T00:00:00Z'),
              ($1,$3,'2026-08-01','me@example.com','2026-08-20T00:00:00Z')`,
      [ids.userId, a, b]
    );
    const log = await getNotificationLog();
    expect(log.map((l) => [l.period, l.threshold])).toEqual([
      ["2026-08", 200000],
      ["2026-07", 100000],
    ]);
    expect((await getNotificationLog(1)).map((l) => l.period)).toEqual(["2026-08"]);
  });

  it("他人の送信履歴は混ざらない", async () => {
    const other = await addOtherUser();
    await pool.query(
      `INSERT INTO notification_log (user_id, rule_id, period, sent_to)
       VALUES ($1,$2,'2026-09-01','other@example.com')`,
      [other.userId, other.ruleId]
    );
    expect(await getNotificationLog()).toEqual([]);
  });
});

// ============================================================
// 6. hasNoTransactions（オンボーディング表示の分岐）
// ============================================================
describe("hasNoTransactions", () => {
  it("0件でtrue、1件入れるとfalse、消すとtrueに戻る", async () => {
    expect(await hasNoTransactions()).toBe(true);
    const id = await addTx(ids, { category: "食料品", type: "expense", amount: 100, date: "2026-09-01" });
    expect(await hasNoTransactions()).toBe(false);
    await del(id);
    expect(await hasNoTransactions()).toBe(true);
  });

  it("他人の取引しか無いときは true（他人の件数で判定しない）", async () => {
    await addOtherUser();
    expect(await hasNoTransactions()).toBe(true);
  });
});

// ============================================================
// 7. /api/export/all — バックアップの完全性
// ============================================================
describe("エクスポート /api/export/all", () => {
  /** 全テーブルに1行ずつ入れて「漏れ」を検出可能にする */
  async function fillEveryTable(ids: Ids) {
    await addTx(ids, { category: "食料品", type: "expense", amount: 3210, date: "2026-09-03", wallet: "銀行A" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-09-25", wallet: "銀行A" });
    await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, transfer_date, kind)
       VALUES ($1,$2,$3,50000,'2026-09-04','cash_withdrawal')`,
      [ids.userId, ids.wallet["銀行A"], ids.wallet["現金"]]
    );
    await pool.query(
      `INSERT INTO card_statements (user_id, wallet_id, period_start, period_end, closing_date, payment_date, settlement_wallet_id)
       VALUES ($1,$2,'2026-08-16','2026-09-15','2026-09-15','2026-10-10',$3)`,
      [ids.userId, ids.wallet["クレカA"], ids.wallet["銀行A"]]
    );
    await pool.query(
      `INSERT INTO recurring_rules (user_id, name, category_id, amount, settlement_wallet_id, start_month, billing_day)
       VALUES ($1,'家賃',$2,129987,$3,'2026-04-01',27)`,
      [ids.userId, ids.cat["家賃"], ids.wallet["銀行A"]]
    );
    await pool.query(
      `INSERT INTO targets (user_id, period, metric, amount) VALUES ($1,'2026-09-01','expense',250000)`,
      [ids.userId]
    );
    await pool.query(
      `INSERT INTO monthly_closings (user_id, period, section, is_closed)
       VALUES ($1,'2026-08-01','variable_cost',true)`,
      [ids.userId]
    );
    const p = await pool.query(
      `INSERT INTO payslips (user_id, period, total_work_hours, source)
       VALUES ($1,'2026-09-01',160.0,'manual') RETURNING id`,
      [ids.userId]
    );
    await pool.query(
      `INSERT INTO payslip_items (payslip_id, item_type, name, category_id, amount)
       VALUES ($1,'deduction','健康保険',$2,18000)`,
      [p.rows[0].id, ids.cat["社会保険料"]]
    );
    await pool.query(
      `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
       VALUES ($1,$2,'2026-09-20',444444)`,
      [ids.userId, ids.wallet["銀行A"]]
    );
    await pool.query(`INSERT INTO vision_notes (user_id, content) VALUES ($1,'目標')`, [ids.userId]);
    const r = await pool.query(
      `INSERT INTO notification_rules (user_id, kind, threshold)
       VALUES ($1,'variable_cost_threshold',123456) RETURNING id`,
      [ids.userId]
    );
    await pool.query(
      `INSERT INTO notification_log (user_id, rule_id, period, sent_to)
       VALUES ($1,$2,'2026-09-01','me@example.com')`,
      [ids.userId, r.rows[0].id]
    );
  }

  const parseExport = async () => {
    const res = await exportAll();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toContain("pl-backup.json");
    return JSON.parse(await res.text()) as {
      exported_at: string;
      user_id: number;
      data: Record<string, Record<string, unknown>[]>;
    };
  };

  it("DBに実在する全テーブルがJSONに含まれる（欠けるとバックアップから消える）", async () => {
    await fillEveryTable(ids);
    const dump = await parseExport();

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`
    );
    const dbTables: string[] = rows.map((r) => r.table_name);
    const missing = dbTables.filter((t) => !(t in dump.data));
    expect(missing).toEqual([]);
    expect(dbTables.length).toBe(16); // 増えたら必ずこのテストが落ちる（エクスポート更新の強制）
  });

  it("各テーブルの件数がDBの実件数と1件も違わない", async () => {
    await fillEveryTable(ids);
    await addOtherUser(); // 他人のデータは数に入らないこと
    const dump = await parseExport();

    const childSql: Record<string, string> = {
      transaction_legs: `SELECT count(*)::int AS n FROM transaction_legs tl
                         JOIN transactions t ON t.id=tl.transaction_id WHERE t.user_id=$1`,
      payslip_items: `SELECT count(*)::int AS n FROM payslip_items pi
                      JOIN payslips p ON p.id=pi.payslip_id WHERE p.user_id=$1`,
      users: `SELECT count(*)::int AS n FROM users WHERE id=$1`,
    };
    for (const [table, rowsOut] of Object.entries(dump.data)) {
      const sql = childSql[table] ?? `SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`;
      const n = await count(sql, [ids.userId]);
      expect([table, rowsOut.length]).toEqual([table, n]);
    }
    // 空のテーブルだけで「一致」してしまわないよう、中身があることも確認
    expect(dump.data.transactions.length).toBe(2);
    expect(dump.data.transaction_legs.length).toBe(2);
    expect(dump.data.payslip_items.length).toBe(1);
    expect(dump.data.users.length).toBe(1);
    expect(dump.data.categories.length).toBe(16);
    expect(dump.data.wallets.length).toBe(3);
  });

  it("金額がそのまま（丸めも型崩れもせず）出る", async () => {
    await fillEveryTable(ids);
    const dump = await parseExport();
    const amounts = dump.data.transactions.map((t) => t.amount).sort((a, b) => Number(a) - Number(b));
    expect(amounts).toEqual([3210, 300000]);
    expect(dump.data.transaction_legs.map((l) => l.amount).sort((a, b) => Number(a) - Number(b)))
      .toEqual([3210, 300000]);
    expect(dump.data.transfers[0].amount).toBe(50000);
    expect(dump.data.balance_snapshots[0].actual_balance).toBe(444444);
    expect(dump.data.notification_rules[0].threshold).toBe(123456);
  });

  it("他人のデータは1行も混ざらない（脚・給与明細行も含めて）", async () => {
    await fillEveryTable(ids);
    const other = await addOtherUser();
    const dump = await parseExport();
    expect(dump.user_id).toBe(1);

    const flat = JSON.stringify(dump);
    expect(flat).not.toContain("other@example.com");
    expect(flat).not.toContain("他人のメモ");
    expect(flat).not.toContain("他人のビジョン");
    expect(flat).not.toContain("他人の銀行");
    expect(dump.data.transactions.every((t) => Number(t.user_id) === Number(ids.userId))).toBe(true);
    expect(dump.data.transaction_legs.every((l) => Number(l.transaction_id) !== other.txId)).toBe(true);
  });

  it("削除した取引はエクスポートにも残らない（脚ごと消える）", async () => {
    const id = await addTx(ids, { category: "外食", type: "expense", amount: 8888, date: "2026-09-08", wallet: "現金" });
    await addTx(ids, { category: "外食", type: "expense", amount: 1111, date: "2026-09-09", wallet: "現金" });
    await del(id);
    const dump = await parseExport();
    expect(dump.data.transactions.map((t) => t.amount)).toEqual([1111]);
    expect(dump.data.transaction_legs.map((l) => l.amount)).toEqual([1111]);
  });

  it("date列は 'YYYY-MM-DD' の文字列で出る（タイムゾーンで1日ずれない）", async () => {
    // 以前はバグだった: pg が date を「実行環境のローカル深夜のDate」に変換し、
    // JSON.stringify がそれをUTCへ直すため、UTCより東のサーバー(JST=+9)では
    // 2026-09-01 → "2026-08-31T15:00:00.000Z" と丸1日（月初なら1か月）ずれていた。
    // 現在は to_char(col,'YYYY-MM-DD') で出すので、実行環境のTZに一切依存しない。
    await fillEveryTable(ids);
    await addTx(ids, { category: "食料品", type: "expense", amount: 1000, date: "2026-09-01", wallet: "現金" });
    const dump = await parseExport();

    // 投入時の文字列がそのまま返る（DBに格納した暦日と一致）
    const tx = dump.data.transactions.find((t) => Number(t.amount) === 1000)!;
    expect(tx.accrual_date).toBe("2026-09-01"); // 月初でも前月へ飛ばない
    expect(dump.data.targets[0].period).toBe("2026-09-01"); // 取引だけの問題ではなかった
    expect(dump.data.transfers[0].transfer_date).toBe("2026-09-04");
    expect(dump.data.monthly_closings[0].period).toBe("2026-08-01");
    expect(dump.data.payslips[0].period).toBe("2026-09-01");
    expect(dump.data.balance_snapshots[0].as_of_date).toBe("2026-09-20");
    expect(dump.data.notification_log[0].period).toBe("2026-09-01");
    expect(dump.data.card_statements[0]).toMatchObject({
      period_start: "2026-08-16",
      period_end: "2026-09-15",
      closing_date: "2026-09-15",
      payment_date: "2026-10-10",
    });
    // NULL許容のdateは "" や "1970-01-01" ではなく null のまま（to_char(NULL)=NULL）
    expect(dump.data.recurring_rules[0].start_month).toBe("2026-04-01");
    expect(dump.data.recurring_rules[0].end_month).toBeNull();

    // 【内部整合】エクスポートに出るdate型の列は、どのテーブルでも1つ残らず
    //   (a) 'YYYY-MM-DD' の形であり、かつ (b) DBが持つ暦日そのものと一致する。
    // 形式だけ見ても「YYYY-MM-DD だが1日ずれている」値は見抜けないので、
    // 同じ行をDB側の to_char で引き直して突き合わせる（これが今回のバグの本体だった）。
    // 子テーブル(transaction_legs/payslip_items)は SELECT * のままなので、
    // そちらに date 列が足された瞬間にこのアサーションが落ちる（取りこぼしの検出）。
    const dateCols = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND data_type='date' ORDER BY 1,2`
    );
    expect(dateCols.rows.length).toBeGreaterThan(0);
    const bad: string[] = [];
    let checked = 0;
    for (const c of dateCols.rows as { table_name: string; column_name: string }[]) {
      // DB側の正解（id → 暦日）。列名・テーブル名は information_schema 由来。
      const truth = new Map<string, string | null>(
        (
          await pool.query(
            `SELECT id, to_char("${c.column_name}",'YYYY-MM-DD') AS v FROM ${c.table_name}`
          )
        ).rows.map((r: { id: unknown; v: string | null }) => [String(r.id), r.v])
      );
      for (const row of dump.data[c.table_name] ?? []) {
        const v = row[c.column_name];
        if (v === null || v === undefined) continue;
        checked++;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
          bad.push(`${c.table_name}.${c.column_name}=${v}（形式が YYYY-MM-DD でない）`);
        } else if (String(v) !== truth.get(String(row.id))) {
          bad.push(
            `${c.table_name}.${c.column_name}=${v} ≠ DB:${truth.get(String(row.id))}（暦日ズレ）`
          );
        }
      }
    }
    expect(bad).toEqual([]);
    // 空振りで「合格」しないこと。内訳（このフィクスチャでは合計14）:
    //   transactions.accrual_date 3 / card_statements 4列×1行 / transfers・targets・
    //   monthly_closings・payslips・balance_snapshots・notification_log・
    //   recurring_rules.start_month 各1 = 3+4+7 = 14
    //   （recurring_rules.end_month は NULL なので数に入らない）
    // 件数を固定しておくと、OWNED からテーブルが1つ落ちた時にも気づける。
    expect(checked).toBe(14);

    // 逆に timestamptz（＝暦日ではなく瞬間）はISO文字列のまま。日付化しすぎていない。
    expect(String(tx.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("同じ取引の日付がCSVとJSONで一致する", async () => {
    // 以前はバグだった: CSVは to_char で正しい暦日、JSONは Date→UTC変換で前日になり、
    // 2つのエクスポートが食い違っていた（JST実行時）。
    await addTx(ids, { category: "外食", type: "expense", amount: 2500, date: "2026-09-01", wallet: "現金" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 400, date: "2026-01-01", wallet: "現金" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 700, date: "2026-12-31", wallet: "現金" });

    // CSVは accrual_date 昇順、JSONは id 昇順なので金額で突き合わせる
    const csv = await (await exportTx()).text();
    const csvLines = csv.split("\r\n").slice(1);
    expect(csvLines).toHaveLength(3);
    const csvDateByAmount = new Map(csvLines.map((l) => [Number(l.split(",")[4]), l.split(",")[0]]));
    expect([...csvDateByAmount.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [400, "2026-01-01"],
      [700, "2026-12-31"],
      [2500, "2026-09-01"],
    ]);

    const dump = await parseExport();
    expect(dump.data.transactions).toHaveLength(3);
    for (const t of dump.data.transactions) {
      // 年またぎ・年末年始・月初のどれでもCSVとJSONが同じ文字列になる
      expect([t.amount, t.accrual_date]).toEqual([t.amount, csvDateByAmount.get(Number(t.amount))]);
    }
  });
});

// ============================================================
// 8. /api/export/transactions — CSV
// ============================================================
describe("エクスポート /api/export/transactions (CSV)", () => {
  // 注意: Response.text() は先頭のUTF-8 BOMを黙って取り除く。BOMの有無は
  // 生バイト（csvBytes）で見る必要がある。文字列側はBOM無しで扱う。
  const csvRes = async () => {
    const res = await exportTx();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("transactions.csv");
    return res;
  };
  const csvText = async () => (await csvRes()).text();
  const csvBytes = async () => new Uint8Array(await (await csvRes()).arrayBuffer());

  it("BOM付き・CRLF改行・9列ヘッダで、1取引=1行", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 3210, date: "2026-09-03", wallet: "銀行A" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-09-25", wallet: "銀行A" });
    const csv = await csvText();

    // Excel(日本語)対策のUTF-8 BOM は生バイトで確認する（text()は剥がしてしまう）
    expect(Array.from((await csvBytes()).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const lines = csv.split("\r\n");
    expect(csv).toContain("\r\n");
    expect(lines[0].split(",")).toEqual([
      "日付", "種別", "カテゴリ", "PL区分", "金額", "決済手段", "メモ", "気分", "登録日時",
    ]);
    expect(lines).toHaveLength(3); // ヘッダ + 2行
    expect(lines[1].startsWith("2026-09-03,支出,食料品,variable_cost,3210,銀行A(3210),")).toBe(true);
    expect(lines[2].startsWith("2026-09-25,収入,給与収入(手取り),income,300000,銀行A(300000),")).toBe(true);
  });

  it("分割払いは決済手段が「A(金額) + B(金額)」になり、脚の合計＝取引金額", async () => {
    const r = await pool.query(
      `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date)
       VALUES ($1,$2,'expense',30000,'2026-09-12') RETURNING id`,
      [ids.userId, ids.cat["日用品"]]
    );
    const id = Number(r.rows[0].id);
    await pool.query(`INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,20000)`, [id, ids.wallet["銀行A"]]);
    await pool.query(`INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,10000)`, [id, ids.wallet["現金"]]);

    const csv = await csvText();
    const row = csv.slice(1).split("\r\n")[1];
    expect(row).toContain(",30000,銀行A(20000) + 現金(10000),");
  });

  it("脚なし取引でも行は出る（決済手段は空欄）", async () => {
    await addTx(ids, { category: "家賃", type: "expense", amount: 129987, date: "2026-08-01" });
    const lines = (await csvText()).slice(1).split("\r\n");
    expect(lines).toHaveLength(2);
    const cells = lines[1].split(",");
    expect(cells.slice(0, 8)).toEqual([
      "2026-08-01", "支出", "家賃", "fixed_cost", "129987", "", "", "",
    ]);
    expect(cells).toHaveLength(9); // 登録日時だけ実行時刻に依存するので列数で確認
  });

  it("カンマ・ダブルクォート入りのメモが列をずらさない", async () => {
    await addTx(ids, {
      category: "食料品", type: "expense", amount: 1500, date: "2026-09-06",
      wallet: "現金", memo: 'スーパー, 特売の"玉子"',
    });
    const csv = await csvText();
    const row = csv.slice(1).split("\r\n")[1];
    expect(row).toContain('"スーパー, 特売の""玉子"""');
    // 列がずれていない＝クォートを考慮した素朴なパーサで9列になる
    const cells = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.filter((_, i, a) => i < a.length - 1);
    expect(cells).toHaveLength(9);
  });

  it("【内部整合】CSVの支出合計 = getPLSummary の 固定費+変動費", async () => {
    await addTx(ids, { category: "家賃", type: "expense", amount: 129987, date: "2026-09-01", wallet: "銀行A" });
    await addTx(ids, { category: "通信費", type: "expense", amount: 8580, date: "2026-09-02", wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 12345, date: "2026-09-05", wallet: "現金" });
    await addTx(ids, { category: "外食", type: "expense", amount: 6789, date: "2026-09-07", wallet: "現金" });
    await addTx(ids, { category: "投資", type: "expense", amount: 50000, date: "2026-09-10", wallet: "銀行A" }); // PL対象外
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-09-25", wallet: "銀行A" });

    const pl = await getPLSummary("2026-09-01");
    expect(pl.fixed).toBe(138567); // 129,987 + 8,580
    expect(pl.variable).toBe(19134); // 12,345 + 6,789
    expect(pl.excluded).toBe(50000);

    const lines = (await csvText()).slice(1).split("\r\n").slice(1);
    let csvExpense = 0;
    let csvIncome = 0;
    let csvExcluded = 0;
    for (const line of lines) {
      const c = line.split(",");
      const [type, plType, amount] = [c[1], c[3], Number(c[4])];
      if (plType === "excluded") csvExcluded += amount;
      else if (type === "支出") csvExpense += amount;
      else csvIncome += amount;
    }
    expect(csvExpense).toBe(pl.fixed + pl.variable);
    expect(csvIncome).toBe(pl.disposable);
    expect(csvExcluded).toBe(pl.excluded);
  });

  it("他人の取引はCSVに出ない", async () => {
    await addOtherUser();
    await addTx(ids, { category: "食料品", type: "expense", amount: 100, date: "2026-09-01" });
    const csv = await csvText();
    expect(csv).not.toContain("他人のメモ");
    expect(csv).not.toContain("9999");
    expect(csv.slice(1).split("\r\n")).toHaveLength(2);
  });

  it("取引0件でもヘッダだけのCSVを返す（空ファイルにしない）", async () => {
    const csv = await csvText();
    expect(csv).toBe("日付,種別,カテゴリ,PL区分,金額,決済手段,メモ,気分,登録日時");
  });
});

// ============================================================
// 9. /api/health
// ============================================================
describe("/api/health", () => {
  it("3テーブルの件数を返す", async () => {
    await pool.query(
      `INSERT INTO recurring_rules (user_id, name, category_id, amount, settlement_wallet_id, start_month)
       VALUES ($1,'家賃',$2,129987,$3,'2026-04-01')`,
      [ids.userId, ids.cat["家賃"], ids.wallet["銀行A"]]
    );
    const body = await (await health()).json();
    expect(body.ok).toBe(true);
    const m = Object.fromEntries(body.counts.map((r: { tbl: string; cnt: number }) => [r.tbl, r.cnt]));
    expect(m).toEqual({ wallets: 3, categories: 16, recurring_rules: 1 });
  });

  it("【現状の記録】件数はユーザー横断の全件で、user_idで絞られていない", async () => {
    // 望ましい挙動ではない（他ユーザーの規模が推測できる）。認証ガードも無い。
    await addOtherUser(); // 他人のウォレット1 / カテゴリ1 を追加
    const body = await (await health()).json();
    const m = Object.fromEntries(body.counts.map((r: { tbl: string; cnt: number }) => [r.tbl, r.cnt]));
    expect(m.wallets).toBe(4); // 自分3 + 他人1
    expect(m.categories).toBe(17); // 自分16 + 他人1
  });
});
