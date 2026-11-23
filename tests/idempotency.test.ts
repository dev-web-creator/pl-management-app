// 取引入力の冪等性と原子性（ADR-040）
// APIハンドラを直接importして呼ぶ。認証envが空なのでrequireAuthApi()はnullを返し、
// currentUserId()は1を返す（= フィクスチャのユーザー）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, type Ids } from "./helpers/fixtures";
import { POST as postTx } from "@/app/api/transactions/route";

let ids: Ids;

function req(body: unknown): Request {
  return new Request("http://localhost/api/transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function counts() {
  const t = await pool.query("select count(*)::int n, coalesce(sum(amount),0)::int s from transactions");
  const l = await pool.query("select count(*)::int n, coalesce(sum(amount),0)::int s from transaction_legs");
  return { tx: t.rows[0], leg: l.rows[0] };
}

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

describe("T03 直列の二重送信", () => {
  it("同じclient_keyで3回POSTしても取引は1件だけ", async () => {
    const body = {
      category_id: ids.cat["外食"],
      type: "expense",
      amount: 1234,
      accrual_date: "2026-10-01",
      wallet_id: ids.wallet["銀行A"],
      client_key: "k-001",
    };
    const r1 = await (await postTx(req(body))).json();
    const r2 = await (await postTx(req(body))).json();
    const r3 = await (await postTx(req(body))).json();

    expect(r1.ok).toBe(true);
    expect(r2).toMatchObject({ ok: true, id: r1.id, duplicate: true });
    expect(r3).toMatchObject({ ok: true, id: r1.id, duplicate: true });

    const c = await counts();
    expect(c.tx).toEqual({ n: 1, s: 1234 });
    expect(c.leg).toEqual({ n: 1, s: 1234 });
  });
});

describe("T04 レース防御の実体＝DBユニーク索引", () => {
  // 注意: Vercel上の本番は複数インスタンス・複数プールで動くため、本物の同時実行は
  // 単一プロセスのこのハーネスでは再現できない（検証済み: 索引を外しても8本同時POSTは
  // プールのキューイングで直列化され1件しか作られなかった）。
  // したがって「レース時に二重計上しない」保証の実体はアプリコードではなくDBの
  // ユニーク索引である。ここではその索引が存在し、実際に効くことを直接証明する。

  it("ユニーク索引 uq_tx_user_client_key が存在する", async () => {
    const r = await pool.query(
      `select indexdef from pg_indexes where indexname='uq_tx_user_client_key'`
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].indexdef).toContain("UNIQUE");
    expect(r.rows[0].indexdef).toContain("client_key");
  });

  it("同じ(user_id, client_key)の2件目はDBが拒否する（23505）", async () => {
    const ins = (k: string) =>
      pool.query(
        `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date, client_key)
         VALUES ($1,$2,'expense',5000,'2026-10-02',$3)`,
        [ids.userId, ids.cat["外食"], k]
      );
    await ins("k-uniq");
    await expect(ins("k-uniq")).rejects.toMatchObject({ code: "23505" });

    const c = await counts();
    expect(c.tx.n).toBe(1);
  });

  it("client_keyがNULLの取引は索引の対象外（何件でも入る）", async () => {
    const ins = () =>
      pool.query(
        `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date, client_key)
         VALUES ($1,$2,'expense',300,'2026-10-02',NULL)`,
        [ids.userId, ids.cat["外食"]]
      );
    await ins();
    await ins();
    const c = await counts();
    expect(c.tx.n).toBe(2);
  });

  it("ハンドラは23505を捕まえて既存idを返す（duplicate:true）", async () => {
    const body = {
      category_id: ids.cat["外食"],
      type: "expense",
      amount: 5000,
      accrual_date: "2026-10-02",
      wallet_id: ids.wallet["銀行A"],
      client_key: "k-conflict",
    };
    const first = await (await postTx(req(body))).json();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => postTx(req(body)).then((r) => r.json()))
    );
    for (const r of results) expect(r).toMatchObject({ ok: true, id: first.id, duplicate: true });
    const c = await counts();
    expect(c.tx).toEqual({ n: 1, s: 5000 });
  });
});

describe("T05 脚合計の検証", () => {
  it("脚合計=金額なら通り、脚は2本作られる", async () => {
    const r = await (
      await postTx(
        req({
          category_id: ids.cat["日用品"],
          type: "expense",
          amount: 10000,
          accrual_date: "2026-10-03",
          legs: [
            { wallet_id: ids.wallet["クレカA"], amount: 8000 },
            { wallet_id: ids.wallet["現金"], amount: 2000 },
          ],
        })
      )
    ).json();
    expect(r.ok).toBe(true);
    const c = await counts();
    expect(c.tx).toEqual({ n: 1, s: 10000 });
    expect(c.leg).toEqual({ n: 2, s: 10000 });
  });

  it("脚合計≠金額は400で弾かれ、1行も残らない", async () => {
    const res = await postTx(
      req({
        category_id: ids.cat["日用品"],
        type: "expense",
        amount: 10000,
        accrual_date: "2026-10-03",
        legs: [
          { wallet_id: ids.wallet["クレカA"], amount: 8000 },
          { wallet_id: ids.wallet["現金"], amount: 1999 },
        ],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("一致しません");
    const c = await counts();
    expect(c.tx.n).toBe(0);
    expect(c.leg.n).toBe(0);
  });
});

describe("T06 失敗時の原子性 / 参照先の検証", () => {
  it("存在しない（＝自分のものでない）walletは400で弾かれ、1行も残らない", async () => {
    const res = await postTx(
      req({
        category_id: ids.cat["日用品"],
        type: "expense",
        amount: 1000,
        accrual_date: "2026-10-04",
        legs: [{ wallet_id: 999999, amount: 1000 }],
      })
    );
    // 所有者チェック(lib/ownership.ts)がDBに到達する前に弾くため、
    // 以前のようなDB例外(500)ではなく明確な400になる。
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("決済手段");
    const c = await counts();
    expect(c.tx.n).toBe(0);
    expect(c.leg.n).toBe(0);
  });

  it("脚の一部だけが不正でも400で弾かれ、1行も残らない", async () => {
    const res = await postTx(
      req({
        category_id: ids.cat["日用品"],
        type: "expense",
        amount: 1000000,
        accrual_date: "2026-10-04",
        legs: [
          { wallet_id: ids.wallet["銀行A"], amount: 700 },
          { wallet_id: 999999, amount: 999300 },
        ],
      })
    );
    expect(res.status).toBe(400);
    const c = await counts();
    expect(c.tx.n).toBe(0);
    expect(c.leg.n).toBe(0);
  });

  it("他人のウォレットは自分の取引に使えない（マルチユーザー分離）", async () => {
    const u = await pool.query(
      `INSERT INTO users (email, display_name) VALUES ('other@example.com','他人') RETURNING id`
    );
    const w = await pool.query(
      `INSERT INTO wallets (user_id,name,type,initial_balance,include_in_assets)
       VALUES ($1,'他人の銀行','bank',1000000,true) RETURNING id`, [u.rows[0].id]
    );
    const res = await postTx(req({
      category_id: ids.cat["外食"], type: "expense", amount: 5000,
      accrual_date: "2026-10-01", wallet_id: w.rows[0].id,
    }));
    expect(res.status).toBe(400);
    expect((await counts()).tx.n).toBe(0);
  });

  it("他人の費目は自分の取引に使えない", async () => {
    const u = await pool.query(
      `INSERT INTO users (email, display_name) VALUES ('other2@example.com','他人') RETURNING id`
    );
    const c = await pool.query(
      `INSERT INTO categories (user_id,name,pl_type) VALUES ($1,'他人の費目','variable_cost') RETURNING id`,
      [u.rows[0].id]
    );
    const res = await postTx(req({
      category_id: c.rows[0].id, type: "expense", amount: 5000,
      accrual_date: "2026-10-01", wallet_id: ids.wallet["銀行A"],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("費目");
    expect((await counts()).tx.n).toBe(0);
  });
});
