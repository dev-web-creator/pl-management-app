// マスタ管理（費目・ウォレット）のCRUD。
//
// ここが壊れると「入力できない」だけでは済まない。費目やウォレットは取引の背骨なので、
// 削除・無効化の扱いを1つ間違えると **過去の金額が静かにズレる / 消える**。
// そのため本ファイルの主眼は「エラーにならないこと」ではなく
//   ・取引が道連れに消えないか
//   ・明細（行）の合計とサマリ（集計）の値が一致し続けるか
// の2点に置く。期待値はすべて手計算のハードコード。
//
// 対象: app/api/categories/route.ts, app/api/categories/[id]/route.ts,
//       app/api/wallets/route.ts, app/api/wallets/[id]/route.ts,
//       lib/queries.ts の getCategoriesForManagement / getWalletsForManagement /
//       getInputCategories / getWalletOptions
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { POST as catPOST } from "@/app/api/categories/route";
import { PUT as catPUT, DELETE as catDELETE } from "@/app/api/categories/[id]/route";
import { POST as walPOST } from "@/app/api/wallets/route";
import { PUT as walPUT, DELETE as walDELETE } from "@/app/api/wallets/[id]/route";
import {
  getInputCategories,
  getWalletOptions,
  getCategoriesForManagement,
  getWalletsForManagement,
  getAssets,
  getWalletBalances,
  getPLSummary,
  getVariableGroups,
  getVariableLeaves,
  getMonthlyIncomeRows,
  getBudgetVsActual,
  getMonthTransactions,
} from "@/lib/queries";

let ids: Ids;
const JUNE = "2026-06-01";

// ---- APIハンドラ呼び出しのショートカット --------------------------------
const json = (url: string, method: string, b: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
const P = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const catAdd = (b: unknown) => catPOST(json("http://localhost/api/categories", "POST", b));
const catEdit = (id: number | string, b: unknown) =>
  catPUT(json(`http://localhost/api/categories/${id}`, "PUT", b), P(id));
const catDel = (id: number | string) =>
  catDELETE(new Request(`http://localhost/api/categories/${id}`, { method: "DELETE" }), P(id));

const walAdd = (b: unknown) => walPOST(json("http://localhost/api/wallets", "POST", b));
const walEdit = (id: number | string, b: unknown) =>
  walPUT(json(`http://localhost/api/wallets/${id}`, "PUT", b), P(id));
const walDel = (id: number | string) =>
  walDELETE(new Request(`http://localhost/api/wallets/${id}`, { method: "DELETE" }), P(id));

/** レスポンスを {status, body} にまとめる */
async function res(r: Response | Promise<Response>) {
  const x = await r;
  return { status: x.status, body: await x.json() };
}
/** 作成系APIを叩いて採番されたidを取り出す（失敗時は本文を見せて落とす） */
async function newId(r: Promise<Response>): Promise<number> {
  const { status, body } = await res(r);
  if (status !== 200) throw new Error(`作成に失敗: ${status} ${JSON.stringify(body)}`);
  return body.id as number;
}

const sum = (rows: { total: number }[]) => rows.reduce((s, r) => s + r.total, 0);
const count = async (sql: string, args: unknown[] = []) =>
  Number((await pool.query(sql, args)).rows[0].n);

/** 別ユーザー（所有権チェック用） */
async function makeOtherUser(): Promise<number> {
  const u = await pool.query(
    `INSERT INTO users (email, display_name, fiscal_year_start_month)
     VALUES ('other@example.com','他人',4) RETURNING id`
  );
  return u.rows[0].id as number;
}

// ---- 基準データ ----------------------------------------------------------
// 2026-06 の家計:
//   変動費  食料品 3,000(銀行A) / 外食 2,000(現金) / 日用品 5,000(銀行A) = 10,000
//   収入    給与収入(手取り) 300,000(銀行A) / 副業収入 50,000(銀行A)    = 350,000
// 残高: 銀行A = 500,000 -3,000 -5,000 +300,000 +50,000 = 842,000
//       現金   =  20,000 -2,000                         =  18,000
//       クレカA=       0
//       総資産 = 860,000 / 未払い 0 / 純資産 860,000
beforeEach(async () => {
  ids = await resetDb();
  await addTx(ids, { category: "食料品", type: "expense", amount: 3000, date: "2026-06-05", wallet: "銀行A" });
  await addTx(ids, { category: "外食", type: "expense", amount: 2000, date: "2026-06-06", wallet: "現金" });
  await addTx(ids, { category: "日用品", type: "expense", amount: 5000, date: "2026-06-07", wallet: "銀行A" });
  await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 300000, date: "2026-06-25", wallet: "銀行A" });
  await addTx(ids, { category: "副業収入", type: "income", amount: 50000, date: "2026-06-20", wallet: "銀行A" });
});
afterAll(async () => {
  await pool.end();
});

// =========================================================================
describe("0. 基準データの健全性（以降の期待値の土台）", () => {
  it("明細の合計とサマリが一致している（この一致が壊れることを以降で検出する）", async () => {
    expect(await getPLSummary(JUNE)).toEqual({
      disposable: 350000,
      fixed: 0,
      variable: 10000,
      surplus: 340000,
      excluded: 0,
    });

    // 変動費: 明細(葉) 合計 === グループ(ロールアップ) 合計 === PLサマリ
    const leaves = await getVariableLeaves(JUNE);
    expect(leaves.map((l) => [l.name, l.total])).toEqual([
      ["食料品", 3000],
      ["外食", 2000],
      ["日用品", 5000],
    ]);
    const groups = await getVariableGroups(JUNE);
    expect(groups.map((g) => [g.name, g.total])).toEqual([["変動費", 10000]]);
    expect(sum(leaves)).toBe(10000);
    expect(sum(groups)).toBe(10000);

    // 収入: 明細合計 === サマリ
    const inc = await getMonthlyIncomeRows(JUNE);
    expect(inc.map((r) => [r.name, r.total])).toEqual([
      ["給与収入(手取り)", 300000],
      ["副業収入", 50000],
    ]);
    expect(sum(inc)).toBe(350000);

    const bva = await getBudgetVsActual(JUNE);
    expect(bva.actual_income).toBe(350000);
    expect(bva.actual_expense).toBe(10000);
  });

  it("残高・資産が手計算どおり", async () => {
    expect(await getAssets()).toEqual({ total_assets: 860000, card_unpaid: 0, net_assets: 860000 });
    const bal = await getWalletBalances();
    expect(bal.find((b) => b.name === "銀行A")?.balance).toBe(842000);
    expect(bal.find((b) => b.name === "現金")?.balance).toBe(18000);
  });
});

// =========================================================================
describe("1. 費目の追加（POST /api/categories）", () => {
  it("親なしで追加でき、入力プルダウンに出る。display_order は MAX+10", async () => {
    const id = await newId(catAdd({ name: "医療費", pl_type: "variable_cost" }));
    const row = (await pool.query(`SELECT * FROM categories WHERE id=$1`, [id])).rows[0];
    expect(row.name).toBe("医療費");
    expect(row.pl_type).toBe("variable_cost");
    expect(row.parent_id).toBeNull();
    expect(row.is_input_allowed).toBe(true);
    expect(row.is_active).toBe(true);
    expect(row.display_order).toBe(10); // フィクスチャは全部 0 なので MAX(0)+10

    const opts = await getInputCategories();
    expect(opts).toHaveLength(11); // 基準10 + 1
    expect(opts.map((o) => o.name)).toContain("医療費");

    // 2件目は 20（採番がインクリメントされる）
    const id2 = await newId(catAdd({ name: "美容費", pl_type: "variable_cost" }));
    expect((await pool.query(`SELECT display_order FROM categories WHERE id=$1`, [id2])).rows[0].display_order).toBe(20);
  });

  it("親を指定すると親が集計ノード化され、親は入力プルダウンから消えて子が出る", async () => {
    const before = await getInputCategories();
    expect(before.map((o) => o.name)).toContain("日用品");

    const id = await newId(catAdd({ name: "掃除用品", pl_type: "variable_cost", parent_id: ids.cat["日用品"] }));

    const parent = (await pool.query(`SELECT is_input_allowed FROM categories WHERE id=$1`, [ids.cat["日用品"]])).rows[0];
    expect(parent.is_input_allowed).toBe(false); // ADR-008: 取引は葉のみ
    const child = (await pool.query(`SELECT parent_id, is_input_allowed FROM categories WHERE id=$1`, [id])).rows[0];
    expect(Number(child.parent_id)).toBe(Number(ids.cat["日用品"]));
    expect(child.is_input_allowed).toBe(true);

    const after = await getInputCategories();
    expect(after.map((o) => o.name)).not.toContain("日用品");
    expect(after.map((o) => o.name)).toContain("掃除用品");
    expect(after).toHaveLength(10); // 親が抜けて子が入るので増減なし
  });

  it("PL区分が違う親は400で弾かれ、DBは一切変わらない", async () => {
    const snap = await count(`SELECT COUNT(*)::int n FROM categories`);
    const r = await res(catAdd({ name: "ダメ", pl_type: "variable_cost", parent_id: ids.cat["家賃"] })); // 家賃=fixed_cost
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("親カテゴリが不正です");
    expect(await count(`SELECT COUNT(*)::int n FROM categories`)).toBe(snap);
    // 巻き込みで親が集計ノード化されていないこと
    expect((await pool.query(`SELECT is_input_allowed FROM categories WHERE id=$1`, [ids.cat["家賃"]])).rows[0].is_input_allowed).toBe(true);
  });

  it("他ユーザーの費目は親に指定できない（400）", async () => {
    const u2 = await makeOtherUser();
    const oc = await pool.query(
      `INSERT INTO categories (user_id, name, pl_type) VALUES ($1,'他人の変動費','variable_cost') RETURNING id`,
      [u2]
    );
    const r = await res(catAdd({ name: "侵入", pl_type: "variable_cost", parent_id: oc.rows[0].id }));
    expect(r.status).toBe(400);
    expect(await count(`SELECT COUNT(*)::int n FROM categories WHERE name='侵入'`)).toBe(0);
  });

  it("同一PL区分の同名アクティブ費目は409。PL区分が違えば作れる", async () => {
    const dup = await res(catAdd({ name: "外食", pl_type: "variable_cost" }));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("同じ名前の費目が既にあります");

    const ok = await res(catAdd({ name: "外食", pl_type: "fixed_cost" }));
    expect(ok.status).toBe(200);
  });

  it("重複で409になったとき、先に走る「親の集計ノード化」がロールバックされる", async () => {
    // 日用品(入力可) を親に、既存名「外食」で追加 → 重複チェックで 409。
    // 親の UPDATE は重複チェックより前に実行されるので、ROLLBACK が効いていないと
    // 「追加に失敗したのに日用品が入力できなくなる」という副作用が残る。
    const r = await res(catAdd({ name: "外食", pl_type: "variable_cost", parent_id: ids.cat["日用品"] }));
    expect(r.status).toBe(409);
    expect((await pool.query(`SELECT is_input_allowed FROM categories WHERE id=$1`, [ids.cat["日用品"]])).rows[0].is_input_allowed).toBe(true);
    expect((await getInputCategories()).map((o) => o.name)).toContain("日用品");
  });

  it("名前空 / 空白のみ / 不正なPL区分は400", async () => {
    expect((await res(catAdd({ name: "", pl_type: "variable_cost" }))).status).toBe(400);
    expect((await res(catAdd({ name: "   ", pl_type: "variable_cost" }))).status).toBe(400);
    expect((await res(catAdd({ name: "X", pl_type: "assets" }))).status).toBe(400);
    expect((await res(catAdd({ name: "X" }))).status).toBe(400);
    expect(await count(`SELECT COUNT(*)::int n FROM categories`)).toBe(16);
  });

  it("名前は前後空白を落として40文字に丸める", async () => {
    const id = await newId(catAdd({ name: "  " + "あ".repeat(45) + "  ", pl_type: "variable_cost" }));
    const name = (await pool.query(`SELECT name FROM categories WHERE id=$1`, [id])).rows[0].name;
    expect(name).toBe("あ".repeat(40));
  });
});

// =========================================================================
describe("2. 費目の改名・無効化（PUT /api/categories/[id]）", () => {
  it("改名できる。取引はそのまま残り、履歴の表示名も追従する", async () => {
    expect((await res(catEdit(ids.cat["外食"], { name: "ランチ" }))).status).toBe(200);

    expect((await getInputCategories()).map((o) => o.name)).toContain("ランチ");
    const txs = await getMonthTransactions(JUNE);
    expect(txs).toHaveLength(5);
    const gaishoku = txs.find((t) => t.amount === 2000);
    expect(gaishoku?.category).toBe("ランチ");
    // 金額は動かない
    expect((await getPLSummary(JUNE)).variable).toBe(10000);
  });

  it("【バグの記録】既存費目と同じ名前に改名できてしまう（ADR-050『重複拒否』は追加時のみ）", async () => {
    // 追加時は409で弾かれるのに、改名は素通りする。
    // これは現状の記録であり、望ましい挙動ではない。
    const r = await res(catEdit(ids.cat["外食"], { name: "食料品" }));
    expect(r.status).toBe(200);

    // 結果: 同一PL区分に同名アクティブ費目が2件。入力プルダウンで区別できない。
    const dupOpts = (await getInputCategories()).filter((o) => o.name === "食料品");
    expect(dupOpts).toHaveLength(2);

    // 月次の変動費明細も「食料品 3,000」「食料品 2,000」の2行になり、
    // どちらがどちらか画面から判別できない（合計は一致するので気づけない）。
    const leaves = await getVariableLeaves(JUNE);
    expect(leaves.filter((l) => l.name === "食料品").map((l) => l.total)).toEqual([3000, 2000]);
    expect(sum(leaves)).toBe(10000);
  });

  it("アクティブな子が残っている親は無効化できない（409）。子を全部無効化すれば通る", async () => {
    const ng = await res(catEdit(ids.cat["食費"], { is_active: false }));
    expect(ng.status).toBe(409);
    expect(ng.body.error).toContain("先に配下の費目を無効化してください");
    expect((await pool.query(`SELECT is_active FROM categories WHERE id=$1`, [ids.cat["食費"]])).rows[0].is_active).toBe(true);

    expect((await res(catEdit(ids.cat["食料品"], { is_active: false }))).status).toBe(200);
    expect((await res(catEdit(ids.cat["外食"], { is_active: false }))).status).toBe(200);
    expect((await res(catEdit(ids.cat["食費"], { is_active: false }))).status).toBe(200);
  });

  it("無効化した費目は入力プルダウンから消えるが、既存取引は消えない", async () => {
    expect((await res(catEdit(ids.cat["外食"], { is_active: false }))).status).toBe(200);

    const opts = await getInputCategories();
    expect(opts.map((o) => o.name)).not.toContain("外食");
    expect(opts).toHaveLength(9);

    // 取引そのものは1件も消えていない
    expect(await count(`SELECT COUNT(*)::int n FROM transactions`)).toBe(5);
    expect(await count(`SELECT COUNT(*)::int n FROM transaction_legs`)).toBe(5);
    const txs = await getMonthTransactions(JUNE);
    expect(txs).toHaveLength(5);
    expect(txs.find((t) => t.amount === 2000)?.category).toBe("外食");
  });

  it("無効化 → 復活でプルダウンに戻る", async () => {
    await catEdit(ids.cat["外食"], { is_active: false });
    expect((await getInputCategories()).map((o) => o.name)).not.toContain("外食");
    expect((await res(catEdit(ids.cat["外食"], { is_active: true }))).status).toBe(200);
    expect((await getInputCategories()).map((o) => o.name)).toContain("外食");
  });

  it("更新項目なし / 空名 / 不正id / 他人の費目 は弾かれる", async () => {
    expect((await res(catEdit(ids.cat["外食"], {}))).status).toBe(400);
    expect((await res(catEdit(ids.cat["外食"], { name: "   " }))).status).toBe(400);
    expect((await res(catEdit(0, { name: "X" }))).status).toBe(400);
    expect((await res(catEdit("abc", { name: "X" }))).status).toBe(400);
    expect((await res(catEdit(99999, { name: "X" }))).status).toBe(404);

    const u2 = await makeOtherUser();
    const oc = await pool.query(`INSERT INTO categories (user_id, name, pl_type) VALUES ($1,'他人費目','variable_cost') RETURNING id`, [u2]);
    expect((await res(catEdit(oc.rows[0].id, { name: "乗っ取り" }))).status).toBe(404);
    expect((await pool.query(`SELECT name FROM categories WHERE id=$1`, [oc.rows[0].id])).rows[0].name).toBe("他人費目");
  });
});

// =========================================================================
describe("3. 費目の削除（DELETE /api/categories/[id]）", () => {
  it("取引がある費目は409。取引は1件も消えない（ON DELETE CASCADE になっていない）", async () => {
    const r = await res(catDel(ids.cat["食料品"]));
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("無効化");
    expect(await count(`SELECT COUNT(*)::int n FROM categories WHERE id=$1`, [ids.cat["食料品"]])).toBe(1);
    expect(await count(`SELECT COUNT(*)::int n FROM transactions`)).toBe(5);
    expect((await getPLSummary(JUNE)).variable).toBe(10000);
  });

  it("【砦】アプリの参照チェックをすり抜けても、DBのFK(RESTRICT)が取引ごと消えるのを止める", async () => {
    await expect(
      pool.query(`DELETE FROM categories WHERE id=$1`, [ids.cat["食料品"]])
    ).rejects.toMatchObject({ code: "23503" });
    expect(await count(`SELECT COUNT(*)::int n FROM transactions`)).toBe(5);
  });

  it("子費目がある費目は409", async () => {
    expect((await res(catDel(ids.cat["食費"]))).status).toBe(409);
    expect(await count(`SELECT COUNT(*)::int n FROM categories WHERE id=$1`, [ids.cat["食費"]])).toBe(1);
  });

  it("固定費マスタ（recurring_rules）から参照されている費目は409", async () => {
    await pool.query(
      `INSERT INTO recurring_rules (user_id, name, category_id, amount, settlement_wallet_id, start_month)
       VALUES ($1,'家賃',$2,129000,$3,'2026-04-01')`,
      [ids.userId, ids.cat["家賃"], ids.wallet["銀行A"]]
    );
    const r = await res(catDel(ids.cat["家賃"]));
    expect(r.status).toBe(409);
    expect(await count(`SELECT COUNT(*)::int n FROM recurring_rules`)).toBe(1);
  });

  it("未使用の費目は物理削除される", async () => {
    const id = await newId(catAdd({ name: "使わない費目", pl_type: "variable_cost" }));
    const r = await res(catDel(id));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, deleted: true });
    expect(await count(`SELECT COUNT(*)::int n FROM categories WHERE id=$1`, [id])).toBe(0);
  });

  it("【バグの記録】給与明細の明細行から参照されていても物理削除され、紐付けが静かに外れる", async () => {
    // 参照カウントは transactions / 子カテゴリ / recurring_rules の3つしか見ていない。
    // payslip_items.category_id は ON DELETE SET NULL なので、エラーも警告も出ずに NULL 化される。
    // これは現状の記録であり、望ましい挙動ではない。
    const p = await pool.query(
      `INSERT INTO payslips (user_id, period, source) VALUES ($1,'2026-06-01','manual') RETURNING id`,
      [ids.userId]
    );
    await pool.query(
      `INSERT INTO payslip_items (payslip_id, item_type, name, category_id, amount)
       VALUES ($1,'deduction','社会保険料',$2,45000)`,
      [p.rows[0].id, ids.cat["社会保険料"]]
    );

    const r = await res(catDel(ids.cat["社会保険料"]));
    expect(r.status).toBe(200); // 本来は409で「無効化してください」になるべき
    expect(r.body.deleted).toBe(true);

    const item = (await pool.query(`SELECT category_id, amount FROM payslip_items`)).rows[0];
    expect(item.category_id).toBeNull(); // 静かに紐付けが外れた
    expect(item.amount).toBe(45000); // 金額だけが残り、控除の分類が失われる
  });

  it("【バグの記録】振替手数料の費目として参照されていても物理削除され、紐付けが静かに外れる", async () => {
    // transfers.fee_category_id も ON DELETE SET NULL。参照カウントに入っていない。
    // これは現状の記録であり、望ましい挙動ではない。
    const feeId = await newId(catAdd({ name: "振込手数料", pl_type: "fixed_cost", parent_id: ids.cat["固定費"] }));
    await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, fee, fee_category_id, kind, transfer_date)
       VALUES ($1,$2,$3,50000,330,$4,'transfer','2026-06-10')`,
      [ids.userId, ids.wallet["銀行A"], ids.wallet["現金"], feeId]
    );

    const r = await res(catDel(feeId));
    expect(r.status).toBe(200); // 本来は409であるべき
    const tf = (await pool.query(`SELECT fee, fee_category_id FROM transfers`)).rows[0];
    expect(tf.fee_category_id).toBeNull();
    expect(tf.fee).toBe(330); // 手数料330円は残るが、どの費目だったか分からなくなる
  });

  it("不正id / 存在しないid / 他人の費目 は削除できない", async () => {
    expect((await res(catDel(0))).status).toBe(400);
    expect((await res(catDel("abc"))).status).toBe(400);
    expect((await res(catDel(99999))).status).toBe(404);

    const u2 = await makeOtherUser();
    const oc = await pool.query(`INSERT INTO categories (user_id, name, pl_type) VALUES ($1,'他人費目','variable_cost') RETURNING id`, [u2]);
    expect((await res(catDel(oc.rows[0].id))).status).toBe(404);
    expect(await count(`SELECT COUNT(*)::int n FROM categories WHERE id=$1`, [oc.rows[0].id])).toBe(1);
  });
});

// =========================================================================
describe("4. 費目ツリーの循環参照", () => {
  it("APIからは親を変更できないため、自分を親・孫を親にする経路が存在しない", async () => {
    // PUT が受け付けるのは name / is_active のみ。parent_id は無視される（安全側・ADR-050）。
    const r = await res(catEdit(ids.cat["食費"], { name: "食費", parent_id: ids.cat["食料品"] }));
    expect(r.status).toBe(200);
    expect((await pool.query(`SELECT parent_id FROM categories WHERE id=$1`, [ids.cat["食費"]])).rows[0].parent_id).toBe(String(ids.cat["変動費"]));

    // POST は新規作成しかできないので、自分自身を親にする経路がそもそも無い。
    // 存在しない親idも弾かれる。
    expect((await res(catAdd({ name: "自己参照", pl_type: "variable_cost", parent_id: 99999 }))).status).toBe(400);

    // 孫を親にする（食費 → 食料品 の付け替え）も API では不可能。
    expect((await pool.query(`SELECT parent_id FROM categories WHERE id=$1`, [ids.cat["食費"]])).rows[0].parent_id).toBe(String(ids.cat["変動費"]));
  });

  it("【バグの記録】DB側に循環を止める仕組みは無い（直UPDATEでループが作れてしまう）", async () => {
    // API経路は塞がっているが、DBには CHECK もトリガもインデックスも無い。
    // 将来「親の付け替え」を実装したり、インポート/復元で直接書き込んだりすると
    // そのまま循環が入り、集計側の再帰CTE（getVariableGroups の subtree など）が
    // 停止条件を失う。これは現状の記録であり、望ましい挙動ではない。
    //
    // ※ 循環した状態で実際の集計クエリを流すと無限再帰でDBを巻き込むため、
    //    ここでは深さ上限つきの検査クエリで「根に到達しない＝循環している」ことだけ確認する。
    await pool.query(`UPDATE categories SET parent_id=$1 WHERE id=$2`, [ids.cat["食料品"], ids.cat["食費"]]);

    const probe = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, 1 AS depth FROM categories WHERE id=$1
         UNION ALL
         SELECT c.id, c.parent_id, up.depth+1 FROM categories c JOIN up ON c.id = up.parent_id
         WHERE up.depth < 20
       )
       SELECT COUNT(*)::int AS hops, COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS roots FROM up`,
      [ids.cat["食料品"]]
    );
    // 深さ20まで辿っても根(parent_id IS NULL)に到達しない＝ループしている
    expect(probe.rows[0].roots).toBe(0);
    expect(probe.rows[0].hops).toBe(20);

    // 後始末（循環を残したまま他テストへ持ち越さない）
    await pool.query(`UPDATE categories SET parent_id=$1 WHERE id=$2`, [ids.cat["変動費"], ids.cat["食費"]]);
    expect(sum(await getVariableGroups(JUNE))).toBe(10000);
  });
});

// =========================================================================
describe("5. 無効化・グループ化が月次の金額に与える影響（明細 vs サマリ）", () => {
  it("費目を無効化しても、実績のある月の明細には残り、グループ合計・PLと一致し続ける", async () => {
    // 以前は getVariableLeaves だけが l.is_active で絞っていたため、無効化した瞬間に
    // その費目の金額が明細から消え、getVariableGroups / getPLSummary の合計と食い違った（バグ）。
    // 現在は「無効でもその月に実績があれば明細に残す」ので、内訳と合計が一致する。
    expect((await res(catEdit(ids.cat["外食"], { is_active: false }))).status).toBe(200);

    // 外食は無効だが 2026-06 に 2,000 の実績があるので明細に残る
    const leaves = await getVariableLeaves(JUNE);
    expect(leaves.map((l) => [l.name, l.total])).toEqual([
      ["食料品", 3000],
      ["外食", 2000],
      ["日用品", 5000],
    ]);
    expect(sum(leaves)).toBe(10000); // 3,000 + 2,000 + 5,000

    expect(sum(await getVariableGroups(JUNE))).toBe(10000);
    expect((await getPLSummary(JUNE)).variable).toBe(10000);
    expect((await getBudgetVsActual(JUNE)).actual_expense).toBe(10000);

    // 内訳の合計 === グループ合計 === PLサマリ（このゼロ差分が再発検知の要）
    expect(sum(await getVariableGroups(JUNE)) - sum(leaves)).toBe(0);
    expect(sum(leaves)).toBe((await getPLSummary(JUNE)).variable);

    // 一方で「実績が無い月」には出ない（無効化が効いていないわけではない）。
    // 2026-07 は取引ゼロなので、外食だけが明細から落ちて有効な葉が0円で並ぶ。
    const july = await getVariableLeaves("2026-07-01");
    expect(july.map((l) => [l.name, l.total])).toEqual([
      ["食料品", 0],
      ["日用品", 0],
    ]);
    expect(sum(july)).toBe(sum(await getVariableGroups("2026-07-01"))); // 0 === 0
  });

  it("収入費目を無効化しても、実績のある月の収入明細には残り、PL・予実と一致し続ける", async () => {
    // 以前は無効化すると副業50,000が収入明細から消え、PLの可処分所得だけ350,000のままだった（バグ）。
    expect((await res(catEdit(ids.cat["副業収入"], { is_active: false }))).status).toBe(200);

    const rows = await getMonthlyIncomeRows(JUNE);
    expect(rows.map((r) => [r.name, r.total])).toEqual([
      ["給与収入(手取り)", 300000],
      ["副業収入", 50000],
    ]);
    expect(sum(rows)).toBe(350000); // 300,000 + 50,000

    expect((await getPLSummary(JUNE)).disposable).toBe(350000);
    expect((await getBudgetVsActual(JUNE)).actual_income).toBe(350000);
    // 明細合計 === PLサマリ === 予実の実績収入
    expect(350000 - sum(rows)).toBe(0);
    expect(sum(rows)).toBe((await getBudgetVsActual(JUNE)).actual_income);

    // 実績が無い月では無効化どおり明細から消える
    const july = await getMonthlyIncomeRows("2026-07-01");
    expect(july.map((r) => [r.name, r.total])).toEqual([["給与収入(手取り)", 0]]);
    expect(sum(july)).toBe((await getPLSummary("2026-07-01")).disposable); // 0 === 0
  });

  it("取引のある費目の配下に子費目を足しても、その費目の金額は明細に残る", async () => {
    // 以前は getVariableLeaves が「子を持たないカテゴリ」だけを明細行にしていたため、
    // 日用品(5,000の実績あり)に子を1つ足した瞬間に日用品が葉でなくなり、5,000円が
    // どの明細行にも現れなくなった（グループ合計には残るので静かにズレた）。バグ。
    // 現在は「その月に実績がある費目は葉でなくても明細に出す」ので金額が保存される。
    expect(sum(await getVariableLeaves(JUNE))).toBe(10000);

    await newId(catAdd({ name: "掃除用品", pl_type: "variable_cost", parent_id: ids.cat["日用品"] }));

    // 日用品は親になり is_input_allowed=false になるが、実績5,000があるので明細に残る。
    // 掃除用品は新設の葉なので0円行として並ぶ（display_order=MAX+10 で最後）。
    const leaves = await getVariableLeaves(JUNE);
    expect(leaves.map((l) => [l.name, l.total])).toEqual([
      ["食料品", 3000],
      ["外食", 2000],
      ["日用品", 5000],
      ["掃除用品", 0],
    ]);
    expect(sum(leaves)).toBe(10000); // 3,000 + 2,000 + 5,000 + 0

    expect(sum(await getVariableGroups(JUNE))).toBe(10000);
    expect((await getPLSummary(JUNE)).variable).toBe(10000);
    expect(sum(await getVariableGroups(JUNE)) - sum(leaves)).toBe(0);

    // 親を二重計上していないこと（日用品5,000が親子で2回数えられていない）
    expect(leaves.filter((l) => l.total === 5000)).toHaveLength(1);

    // 取引自体も当然生きている
    expect(await count(`SELECT COUNT(*)::int n FROM transactions WHERE category_id=$1`, [ids.cat["日用品"]])).toBe(1);
  });
});

// =========================================================================
describe("6. 費目マスタ管理ビュー（getCategoriesForManagement）", () => {
  it("親名・子数・取引数が正しく出る", async () => {
    const rows = await getCategoriesForManagement();
    expect(rows).toHaveLength(16);
    const by = (n: string) => rows.find((r) => r.name === n)!;

    expect(by("変動費")).toMatchObject({ parent_name: null, child_count: 2, tx_count: 0, is_input_allowed: false });
    expect(by("食費")).toMatchObject({ parent_name: "変動費", child_count: 2, tx_count: 0 });
    expect(by("食料品")).toMatchObject({ parent_name: "食費", child_count: 0, tx_count: 1, is_input_allowed: true });
    expect(by("日用品")).toMatchObject({ parent_name: "変動費", child_count: 0, tx_count: 1 });
    expect(by("給与収入(手取り)")).toMatchObject({ parent_name: "収入", child_count: 0, tx_count: 1 });
    expect(by("年額サブスク")).toMatchObject({ parent_name: "固定費", child_count: 0, tx_count: 0 });
  });

  it("無効化しても管理ビューには残り、is_active=false で返る（画面から消えない）", async () => {
    await catEdit(ids.cat["外食"], { is_active: false });
    const rows = await getCategoriesForManagement();
    expect(rows).toHaveLength(16);
    expect(rows.find((r) => r.name === "外食")!.is_active).toBe(false);
  });

  it("tx_count は取引しか数えないので、固定費マスタ専用の費目は『削除可』に見えるが API は409を返す", async () => {
    // UI(CategoryManager) は tx_count===0 && child_count===0 のとき「削除」ボタンを出す。
    // recurring_rules だけが参照している費目はここで削除可能に見え、押すと409になる。
    // 金額はズレないので重大ではないが、ボタンの意味とAPIの判定がズレている。
    await pool.query(
      `INSERT INTO recurring_rules (user_id, name, category_id, amount, settlement_wallet_id, start_month)
       VALUES ($1,'通信',$2,4000,$3,'2026-04-01')`,
      [ids.userId, ids.cat["通信費"], ids.wallet["銀行A"]]
    );
    const row = (await getCategoriesForManagement()).find((r) => r.name === "通信費")!;
    expect(row.tx_count).toBe(0);
    expect(row.child_count).toBe(0); // → 画面上は「削除」ボタン
    expect((await res(catDel(ids.cat["通信費"]))).status).toBe(409); // → 実際は削除不可
  });
});

// =========================================================================
describe("7. ウォレットの追加（POST /api/wallets）", () => {
  it("銀行を追加すると期首残高がそのまま総資産に乗る", async () => {
    const id = await newId(walAdd({ name: "銀行B", type: "bank", initial_balance: 100000 }));
    const w = (await pool.query(`SELECT * FROM wallets WHERE id=$1`, [id])).rows[0];
    expect(w.type).toBe("bank");
    expect(w.initial_balance).toBe(100000);
    expect(w.include_in_assets).toBe(true);
    expect(w.is_balance_tracked).toBe(true);
    expect(w.is_active).toBe(true);
    expect(w.settlement_wallet_id).toBeNull();

    expect(await getAssets()).toEqual({ total_assets: 960000, card_unpaid: 0, net_assets: 960000 });
    expect((await getWalletOptions()).map((o) => o.name)).toEqual(["銀行A", "銀行B", "現金", "クレカA"]);
  });

  it("現金は既定で残高追跡オフ、その他は既定でオン", async () => {
    const cashId = await newId(walAdd({ name: "小銭入れ", type: "cash", initial_balance: 5000 }));
    expect((await pool.query(`SELECT is_balance_tracked FROM wallets WHERE id=$1`, [cashId])).rows[0].is_balance_tracked).toBe(false);
    const ppId = await newId(walAdd({ name: "PayPay", type: "prepaid", initial_balance: 3000 }));
    expect((await pool.query(`SELECT is_balance_tracked FROM wallets WHERE id=$1`, [ppId])).rows[0].is_balance_tracked).toBe(true);
    expect((await getAssets()).total_assets).toBe(868000); // 860,000 + 5,000 + 3,000
  });

  it("クレカは締め日・支払日が必須。1〜31の範囲外や小数は400", async () => {
    const base = { name: "クレカB", type: "credit_card" };
    expect((await res(walAdd({ ...base }))).body.error).toContain("締め日");
    expect((await res(walAdd({ ...base, closing_day: 15 }))).body.error).toContain("支払日");
    expect((await res(walAdd({ ...base, closing_day: 32, payment_day: 10 }))).body.error).toContain("1〜31");
    expect((await res(walAdd({ ...base, closing_day: 0, payment_day: 10 }))).body.error).toContain("1〜31");
    expect((await res(walAdd({ ...base, closing_day: 15.5, payment_day: 10 }))).body.error).toContain("1〜31");
    expect((await res(walAdd({ ...base, closing_day: 15, payment_day: 40 }))).body.error).toContain("1〜31");
    expect(await count(`SELECT COUNT(*)::int n FROM wallets`)).toBe(3);
  });

  it("末締め・末払いなら日付指定なしで作れ、closing_day/payment_day は NULL になる", async () => {
    const id = await newId(walAdd({ name: "クレカB", type: "credit_card", closing_eom: true, payment_eom: true }));
    const w = (await pool.query(`SELECT * FROM wallets WHERE id=$1`, [id])).rows[0];
    expect(w.closing_day).toBeNull();
    expect(w.closing_eom).toBe(true);
    expect(w.payment_day).toBeNull();
    expect(w.payment_eom).toBe(true);
    expect(w.payment_month_offset).toBe(1);
  });

  it("クレカは include_in_assets が必ず false に矯正される（true を送っても）", async () => {
    const id = await newId(walAdd({ name: "クレカB", type: "credit_card", closing_day: 27, payment_day: 10, include_in_assets: true }));
    expect((await pool.query(`SELECT include_in_assets FROM wallets WHERE id=$1`, [id])).rows[0].include_in_assets).toBe(false);
    expect((await getAssets()).total_assets).toBe(860000);
  });

  it("引落先は自分の銀行/プリペイドのみ。現金・クレカ・存在しないidは400", async () => {
    const base = { name: "クレカB", type: "credit_card", closing_day: 27, payment_day: 10 };
    expect((await res(walAdd({ ...base, settlement_wallet_id: ids.wallet["現金"] }))).status).toBe(400);
    expect((await res(walAdd({ ...base, settlement_wallet_id: ids.wallet["クレカA"] }))).status).toBe(400);
    expect((await res(walAdd({ ...base, settlement_wallet_id: 99999 }))).status).toBe(400);

    const u2 = await makeOtherUser();
    const ow = await pool.query(`INSERT INTO wallets (user_id, name, type) VALUES ($1,'他人銀行','bank') RETURNING id`, [u2]);
    expect((await res(walAdd({ ...base, settlement_wallet_id: ow.rows[0].id }))).status).toBe(400);

    const id = await newId(walAdd({ ...base, settlement_wallet_id: ids.wallet["銀行A"] }));
    expect(Number((await pool.query(`SELECT settlement_wallet_id FROM wallets WHERE id=$1`, [id])).rows[0].settlement_wallet_id)).toBe(Number(ids.wallet["銀行A"]));
    expect((await getWalletsForManagement()).find((w) => w.name === "クレカB")!.settlement_name).toBe("銀行A");
  });

  it("名称必須・種別は許可リストのみ", async () => {
    expect((await res(walAdd({ name: "", type: "bank" }))).status).toBe(400);
    expect((await res(walAdd({ name: "  ", type: "bank" }))).status).toBe(400);
    expect((await res(walAdd({ name: "X", type: "wallet" }))).status).toBe(400);
    expect((await res(walAdd({ name: "X" }))).status).toBe(400);
    expect(await count(`SELECT COUNT(*)::int n FROM wallets`)).toBe(3);
  });

  it("【バグの記録】クレカの開始残高を正の数で入れると未払いの符号が逆になる", async () => {
    // カード残高は「マイナス＝未払い」で持つ設計だが、開始残高の入力に符号の正規化も注意書きもない。
    // 「未払い30,000円ある状態から始めたい」と素直に 30000 と入れると、
    // 未払いが -30,000 と表示され、純資産が 60,000 ぶんズレる（-30,000 であるべきところ +30,000）。
    // これは現状の記録であり、望ましい挙動ではない。
    await newId(walAdd({ name: "クレカB", type: "credit_card", closing_day: 27, payment_day: 10, initial_balance: 30000 }));
    const a = await getAssets();
    expect(a.total_assets).toBe(860000);
    expect(a.card_unpaid).toBe(-30000); // 本来は +30,000（未払い）
    expect(a.net_assets).toBe(890000); // 本来は 830,000。差は 60,000
  });

  it("【バグの記録】開始残高が数値化できない値だと400ではなく黙って0になる", async () => {
    // Number("500,000") が NaN → `|| 0` で 0 に落ちる。カットオーバー残高が静かに消える。
    // 画面側は入力時に数字以外を除去しているため通常は踏まないが、APIは素通しする。
    // これは現状の記録であり、望ましい挙動ではない。
    const id = await newId(walAdd({ name: "銀行B", type: "bank", initial_balance: "500,000" }));
    expect((await pool.query(`SELECT initial_balance FROM wallets WHERE id=$1`, [id])).rows[0].initial_balance).toBe(0);
    expect((await getAssets()).total_assets).toBe(860000); // 500,000 が丸ごと消えている
  });

  it("【バグの記録】締め→支払オフセットが範囲外でも400にならず黙って1（翌月）になる", async () => {
    const id = await newId(walAdd({ name: "クレカB", type: "credit_card", closing_day: 27, payment_day: 10, payment_month_offset: 9 }));
    expect((await pool.query(`SELECT payment_month_offset FROM wallets WHERE id=$1`, [id])).rows[0].payment_month_offset).toBe(1);
    // 0（当月払い）は正当な値として通る
    const id0 = await newId(walAdd({ name: "クレカC", type: "credit_card", closing_day: 27, payment_day: 28, payment_month_offset: 0 }));
    expect((await pool.query(`SELECT payment_month_offset FROM wallets WHERE id=$1`, [id0])).rows[0].payment_month_offset).toBe(0);
  });

  it("【バグの記録】同名のウォレットを何個でも作れる（費目には重複拒否があるのに）", async () => {
    expect((await res(walAdd({ name: "銀行A", type: "bank", initial_balance: 0 }))).status).toBe(200);
    const opts = (await getWalletOptions()).filter((o) => o.name === "銀行A");
    expect(opts).toHaveLength(2); // 決済手段プルダウンに同名が2つ並び、区別できない
    expect(await count(`SELECT COUNT(*)::int n FROM wallets WHERE name='銀行A'`)).toBe(2);
  });
});

// =========================================================================
describe("8. ウォレットの削除・無効化（DELETE /api/wallets/[id]）", () => {
  it("取引で使われているウォレットは無効化される。取引・脚・残高は一切変わらない", async () => {
    const r = await res(walDel(ids.wallet["現金"]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, deactivated: true });

    expect(await count(`SELECT COUNT(*)::int n FROM wallets WHERE id=$1`, [ids.wallet["現金"]])).toBe(1);
    expect((await pool.query(`SELECT is_active FROM wallets WHERE id=$1`, [ids.wallet["現金"]])).rows[0].is_active).toBe(false);
    expect(await count(`SELECT COUNT(*)::int n FROM transactions`)).toBe(5);
    expect(await count(`SELECT COUNT(*)::int n FROM transaction_legs`)).toBe(5);

    // 資産・残高は履歴として残る（金額が動かないこと）
    expect(await getAssets()).toEqual({ total_assets: 860000, card_unpaid: 0, net_assets: 860000 });
    expect((await getWalletBalances()).find((b) => b.name === "現金")?.balance).toBe(18000);

    // 入力プルダウンからは消える
    expect((await getWalletOptions()).map((o) => o.name)).toEqual(["銀行A", "クレカA"]);
    // 管理ビューには残る
    expect((await getWalletsForManagement()).find((w) => w.name === "現金")!.is_active).toBe(false);
  });

  it("【砦】アプリの参照チェックをすり抜けても、DBのFK(RESTRICT)が脚ごと消えるのを止める", async () => {
    await expect(
      pool.query(`DELETE FROM wallets WHERE id=$1`, [ids.wallet["現金"]])
    ).rejects.toMatchObject({ code: "23503" });
    expect(await count(`SELECT COUNT(*)::int n FROM transaction_legs`)).toBe(5);
  });

  it("引落先として参照されている銀行は無効化される。クレカ側の引落先はNULLにならない", async () => {
    // 銀行A はクレカAの引落先。取引も持っている。
    const r = await res(walDel(ids.wallet["銀行A"]));
    expect(r.body).toEqual({ ok: true, deactivated: true });
    const card = (await pool.query(`SELECT settlement_wallet_id FROM wallets WHERE id=$1`, [ids.wallet["クレカA"]])).rows[0];
    expect(Number(card.settlement_wallet_id)).toBe(Number(ids.wallet["銀行A"]));
    expect((await getWalletsForManagement()).find((w) => w.name === "クレカA")!.settlement_name).toBe("銀行A");
  });

  it("振替・固定費マスタから参照されていても無効化に倒れる", async () => {
    const bId = await newId(walAdd({ name: "銀行B", type: "bank", initial_balance: 0 }));
    await pool.query(
      `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, kind, transfer_date)
       VALUES ($1,$2,$3,10000,'transfer','2026-06-11')`,
      [ids.userId, ids.wallet["銀行A"], bId]
    );
    expect((await res(walDel(bId))).body).toEqual({ ok: true, deactivated: true });

    const cId = await newId(walAdd({ name: "銀行C", type: "bank", initial_balance: 0 }));
    await pool.query(
      `INSERT INTO recurring_rules (user_id, name, category_id, amount, settlement_wallet_id, start_month)
       VALUES ($1,'家賃',$2,129000,$3,'2026-04-01')`,
      [ids.userId, ids.cat["家賃"], cId]
    );
    expect((await res(walDel(cId))).body).toEqual({ ok: true, deactivated: true });
  });

  it("未使用のウォレットは物理削除される", async () => {
    // クレカAは基準データで一度も使っていない
    expect((await getWalletsForManagement()).find((w) => w.name === "クレカA")!.in_use).toBe(false);
    const r = await res(walDel(ids.wallet["クレカA"]));
    expect(r.body).toEqual({ ok: true, deleted: true });
    expect(await count(`SELECT COUNT(*)::int n FROM wallets`)).toBe(2);
    // 他のウォレットは無傷
    expect(await getAssets()).toEqual({ total_assets: 860000, card_unpaid: 0, net_assets: 860000 });
  });

  it("【バグの記録】残高スナップショットしか持たないウォレットは物理削除され、スナップショットがCASCADEで消える", async () => {
    // 参照カウントに balance_snapshots が入っていない。一方 balance_snapshots.wallet_id は
    // ON DELETE CASCADE。暗号資産は「最新スナップショット＝残高」なので、履歴を守るはずの
    // 無効化ではなく物理削除に倒れ、評価額の記録が丸ごと消える。
    // これは現状の記録であり、望ましい挙動ではない。
    const cId = await newId(walAdd({ name: "コインA", type: "crypto", initial_balance: 0 }));
    await pool.query(
      `INSERT INTO balance_snapshots (user_id, wallet_id, as_of_date, actual_balance)
       VALUES ($1,$2,'2026-06-30',1000000)`,
      [ids.userId, cId]
    );
    expect((await getAssets()).total_assets).toBe(1860000);

    const mv = (await getWalletsForManagement()).find((w) => w.name === "コインA")!;
    expect(mv.balance).toBe(1000000);
    expect(mv.in_use).toBe(false); // 画面にも「削除」として出てしまう

    const r = await res(walDel(cId));
    expect(r.body).toEqual({ ok: true, deleted: true }); // 本来は deactivated であるべき
    expect(await count(`SELECT COUNT(*)::int n FROM balance_snapshots`)).toBe(0); // 評価額1,000,000の記録が消滅
    expect((await getAssets()).total_assets).toBe(860000);
  });

  it("【バグの記録】カード明細の引落先としてのみ参照される口座は物理削除され、引落先が静かにNULLになる", async () => {
    // 参照カウントは card_statements.wallet_id（＝カード本体）しか見ておらず、
    // card_statements.settlement_wallet_id（＝引落先口座）を見ていない。
    // FKは ON DELETE SET NULL なので、過去の請求サイクルの引落先が黙って失われる。
    // これは現状の記録であり、望ましい挙動ではない。
    const bId = await newId(walAdd({ name: "銀行B", type: "bank", initial_balance: 0 }));
    await pool.query(
      `INSERT INTO card_statements (user_id, wallet_id, period_start, period_end, closing_date, payment_date, settlement_wallet_id)
       VALUES ($1,$2,'2026-05-16','2026-06-15','2026-06-15','2026-07-10',$3)`,
      [ids.userId, ids.wallet["クレカA"], bId]
    );

    const r = await res(walDel(bId));
    expect(r.body).toEqual({ ok: true, deleted: true }); // 本来は deactivated であるべき
    expect((await pool.query(`SELECT settlement_wallet_id FROM card_statements`)).rows[0].settlement_wallet_id).toBeNull();
  });

  it("不正id / 存在しないid / 他人のウォレット は削除できない", async () => {
    expect((await res(walDel(0))).status).toBe(400);
    expect((await res(walDel("abc"))).status).toBe(400);
    expect((await res(walDel(99999))).status).toBe(404);

    const u2 = await makeOtherUser();
    const ow = await pool.query(`INSERT INTO wallets (user_id, name, type) VALUES ($1,'他人銀行','bank') RETURNING id`, [u2]);
    expect((await res(walDel(ow.rows[0].id))).status).toBe(404);
    expect(await count(`SELECT COUNT(*)::int n FROM wallets WHERE id=$1`, [ow.rows[0].id])).toBe(1);
  });
});

// =========================================================================
describe("9. 引落先ウォレットの自己参照ループ", () => {
  it("自分自身を引落先にはできない（PUTで400）", async () => {
    const self = Number(ids.wallet["クレカA"]);
    const base = { name: "クレカA", type: "credit_card", closing_day: 15, payment_day: 10 };

    // 専用ガード（settlement_wallet_id === wid）に当たる経路
    const r = await res(walEdit(self, { ...base, settlement_wallet_id: self }));
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("引落先に自分自身");

    // 専用ガードは `===` 比較なので、idを文字列で送ると素通りする。
    // ただし後段の「引落先は銀行/プリペイドのみ」チェックが必ず受け止めるため、
    // 自己参照ループが成立する経路は残っていない（エラー文言だけが変わる）。
    const r2 = await res(walEdit(self, { ...base, settlement_wallet_id: String(self) }));
    expect(r2.status).toBe(400);
    expect(r2.body.error).toContain("引落先は自分の銀行/プリペイド口座");

    // どちらの経路でもDBは書き換わっていない
    expect((await pool.query(`SELECT settlement_wallet_id, name FROM wallets WHERE id=$1`, [self])).rows[0]).toMatchObject({
      settlement_wallet_id: String(ids.wallet["銀行A"]),
      name: "クレカA",
    });
  });

  it("カード同士の相互参照は作れない（引落先は銀行/プリペイドに限定されるため）", async () => {
    const bId = await newId(walAdd({ name: "クレカB", type: "credit_card", closing_day: 27, payment_day: 10 }));
    // クレカA → クレカB
    const r1 = await res(walEdit(ids.wallet["クレカA"], {
      name: "クレカA", type: "credit_card", closing_day: 15, payment_day: 10,
      settlement_wallet_id: bId,
    }));
    expect(r1.status).toBe(400);
    // クレカB → クレカA
    const r2 = await res(walEdit(bId, {
      name: "クレカB", type: "credit_card", closing_day: 27, payment_day: 10,
      settlement_wallet_id: ids.wallet["クレカA"],
    }));
    expect(r2.status).toBe(400);

    // 銀行に引落先を設定しようとしても、カード以外では無視されてNULLのまま
    const ok = await res(walEdit(ids.wallet["銀行A"], {
      name: "銀行A", type: "bank", initial_balance: 500000,
      settlement_wallet_id: ids.wallet["現金"],
    }));
    expect(ok.status).toBe(200);
    expect((await pool.query(`SELECT settlement_wallet_id FROM wallets WHERE id=$1`, [ids.wallet["銀行A"]])).rows[0].settlement_wallet_id).toBeNull();
  });
});

// =========================================================================
describe("10. ウォレット管理ビュー（getWalletsForManagement）", () => {
  it("残高・引落先名・使用中フラグが正しい", async () => {
    const rows = await getWalletsForManagement();
    expect(rows).toHaveLength(3);
    const by = (n: string) => rows.find((r) => r.name === n)!;

    expect(by("銀行A")).toMatchObject({ type: "bank", initial_balance: 500000, balance: 842000, in_use: true, is_active: true });
    expect(by("現金")).toMatchObject({ type: "cash", initial_balance: 20000, balance: 18000, in_use: true, is_balance_tracked: true });
    expect(by("クレカA")).toMatchObject({
      type: "credit_card", balance: 0, in_use: false,
      closing_day: 15, payment_day: 10, payment_month_offset: 1, settlement_name: "銀行A",
    });

    // 管理ビューの残高合計 = getWalletBalances の合計（内部整合）
    const viaBalances = (await getWalletBalances()).reduce((s, b) => s + b.balance, 0);
    expect(rows.reduce((s, r) => s + r.balance, 0)).toBe(viaBalances);
    expect(viaBalances).toBe(860000);
  });

  it("無効化したウォレットは末尾に回るが残高はそのまま（履歴が保たれる）", async () => {
    await walDel(ids.wallet["銀行A"]); // 参照ありなので無効化
    const rows = await getWalletsForManagement();
    expect(rows.map((r) => r.name)).toEqual(["現金", "クレカA", "銀行A"]); // is_active DESC
    expect(rows.find((r) => r.name === "銀行A")).toMatchObject({ is_active: false, balance: 842000 });
  });
});
