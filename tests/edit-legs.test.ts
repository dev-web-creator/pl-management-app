// 取引の編集(PUT)が、決済手段の脚(transaction_legs)と総資産に与える影響。
// 本番データの99.3%(2,186/2,202件)が「脚なし」なので、ここの挙動は運用に直撃する。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { PUT as putTx } from "@/app/api/transactions/[id]/route";
import { getAssets, getWalletBalances } from "@/lib/queries";

let ids: Ids;

function putReq(id: number, body: unknown) {
  return [
    new Request(`http://localhost/api/transactions/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) },
  ] as const;
}

async function legsOf(txId: number) {
  const r = await pool.query(
    `select wallet_id, amount from transaction_legs where transaction_id=$1 order by id`,
    [txId]
  );
  return r.rows;
}

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

describe("T07 脚を持たない過去取引の編集", () => {
  it("メモだけ直すと、脚が1本生えて総資産が金額分ずれる", async () => {
    // インポート由来を再現：脚を持たない過去の支出
    const txId = await addTx(ids, {
      category: "外食",
      type: "expense",
      amount: 40700,
      date: "2025-05-10",
      // wallet を渡さない = 脚なし
    });
    expect(await legsOf(txId)).toHaveLength(0);

    const before = await getAssets();
    // 銀行A 500,000 + 現金 20,000 = 520,000（クレカは総資産に含まない）
    expect(before.total_assets).toBe(520000);

    // 編集画面が実際に送るbody（wallet_id は先頭ウォレットにフォールバックされる）
    const [req, ctx] = putReq(txId, {
      category_id: ids.cat["外食"],
      type: "expense",
      amount: 40700,
      accrual_date: "2025-05-10",
      memo: "メモだけ変更",
      wallet_id: ids.wallet["銀行A"], // ← page.tsx:48 の wallets[0] フォールバック
    });
    const res = await putTx(req, ctx);
    expect(res.status).toBe(200);

    const after = await getAssets();
    const legs = await legsOf(txId);

    console.log(
      `\n[T07] 脚: ${0}本 → ${legs.length}本 / 総資産: ${before.total_assets} → ${after.total_assets} (差 ${after.total_assets - before.total_assets})`
    );

    // 【修正後】脚は生えず、総資産も動かない
    expect(legs).toHaveLength(0);
    expect(after.total_assets).toBe(520000);
  });

  it("attach_wallet=true を明示したときだけ脚が作られ、残高に反映される", async () => {
    const txId = await addTx(ids, {
      category: "外食", type: "expense", amount: 40700, date: "2025-05-10",
    });
    const before = await getAssets();

    const [req, ctx] = putReq(txId, {
      category_id: ids.cat["外食"],
      type: "expense",
      amount: 40700,
      accrual_date: "2025-05-10",
      memo: "決済手段を紐付ける",
      wallet_id: ids.wallet["銀行A"],
      attach_wallet: true,
    });
    expect((await putTx(req, ctx)).status).toBe(200);

    expect(await legsOf(txId)).toHaveLength(1);
    expect((await getAssets()).total_assets).toBe(before.total_assets - 40700);
  });

  it("脚なし取引の編集は wallet_id を送らなくても200で保存できる", async () => {
    const txId = await addTx(ids, {
      category: "外食", type: "expense", amount: 40700, date: "2025-05-10",
    });
    const [req, ctx] = putReq(txId, {
      category_id: ids.cat["外食"],
      type: "expense",
      amount: 40700,
      accrual_date: "2025-05-10",
      memo: "wallet_idなし",
    });
    expect((await putTx(req, ctx)).status).toBe(200);
    expect(await legsOf(txId)).toHaveLength(0);
    const r = await pool.query("select memo from transactions where id=$1", [txId]);
    expect(r.rows[0].memo).toBe("wallet_idなし");
  });

  it("脚なし取引はフォームの警告条件(legCount > 1)に引っかからない", async () => {
    const txId = await addTx(ids, {
      category: "外食", type: "expense", amount: 40700, date: "2025-05-10",
    });
    const r = await pool.query(
      `select count(*)::int lc from transaction_legs where transaction_id=$1`, [txId]
    );
    const legCount = r.rows[0].lc;
    expect(legCount).toBe(0);
    // components/AddTransactionForm.tsx:159 の条件
    expect(legCount > 1).toBe(false); // = 警告が表示されない
  });
});

describe("T08 分割払い取引の編集", () => {
  it("【仕様】脚を持つ取引は従来どおり単一脚に集約される（フォームに警告あり）", async () => {
    // クレカ8,000 + 現金2,000 の分割払い
    const r = await pool.query(
      `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date)
       VALUES ($1,$2,'expense',10000,'2026-10-04') RETURNING id`,
      [ids.userId, ids.cat["日用品"]]
    );
    const txId = r.rows[0].id;
    await pool.query(
      `INSERT INTO transaction_legs (transaction_id, wallet_id, amount)
       VALUES ($1,$2,8000),($1,$3,2000)`,
      [txId, ids.wallet["クレカA"], ids.wallet["現金"]]
    );

    const before = await getAssets();
    const beforeBal = await getWalletBalances();
    expect(await legsOf(txId)).toHaveLength(2);

    const [req, ctx] = putReq(txId, {
      category_id: ids.cat["日用品"],
      type: "expense",
      amount: 10000,
      accrual_date: "2026-10-04",
      memo: "メモ修正",
      wallet_id: ids.wallet["クレカA"],
    });
    await putTx(req, ctx);

    const after = await getAssets();
    const afterBal = await getWalletBalances();
    const legs = await legsOf(txId);

    const cashBefore = beforeBal.find((b) => b.name === "現金")?.balance;
    const cashAfter = afterBal.find((b) => b.name === "現金")?.balance;
    console.log(
      `\n[T08] 脚: 2本 → ${legs.length}本 / 現金残高: ${cashBefore} → ${cashAfter} / カード未払い: ${before.card_unpaid} → ${after.card_unpaid}`
    );

    expect(legs).toHaveLength(1);
    expect(cashBefore).toBe(18000);
    expect(cashAfter).toBe(20000); // 現金から引かれていた2,000が戻ってしまう
    expect(before.card_unpaid).toBe(8000);
    expect(after.card_unpaid).toBe(10000);
  });

  it("分割払いは警告条件(legCount > 1)に引っかかる（警告は出る）", async () => {
    const r = await pool.query(
      `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date)
       VALUES ($1,$2,'expense',10000,'2026-10-04') RETURNING id`,
      [ids.userId, ids.cat["日用品"]]
    );
    await pool.query(
      `INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,8000),($1,$3,2000)`,
      [r.rows[0].id, ids.wallet["クレカA"], ids.wallet["現金"]]
    );
    const c = await pool.query(
      `select count(*)::int lc from transaction_legs where transaction_id=$1`, [r.rows[0].id]
    );
    expect(c.rows[0].lc > 1).toBe(true); // = 警告が表示される
  });
});
