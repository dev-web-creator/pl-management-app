// リコンサイル（残高照合）とスナップショット。10/1カットオーバーの中核画面。
//
// ここが狂うと期首残高の投入が全部ズレる。見るのは「落ちないこと」ではなく
// 「画面に出る金額が正しいか」「記録した値が本当にDBに入ったか」。
//
// tests/cutover-balance-sync.test.ts は 002_sync_initial_balance.sql 単体を
// getWalletBalances で検証している。こちらは /reconcile 画面が見せる値
// （getReconcileData）と、実際の書き込み経路（POST /api/snapshots）を見る。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { getReconcileData, getAssetTarget, getAssets, getWalletBalances } from "@/lib/queries";
import { POST as postSnapshots } from "@/app/api/snapshots/route";

let ids: Ids;

// ---- ヘルパー ----

type Item = { wallet_id: unknown; actual_balance: unknown };

const post = (body: unknown) =>
  postSnapshots(
    new Request("http://localhost/api/snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

/** /reconcile の「実残高を記録する」ボタンと同じ経路 */
const record = (as_of_date: string, items: Item[]) => post({ as_of_date, items });

/** 画面1行分を名前で引く */
async function row(name: string) {
  const rows = await getReconcileData();
  const r = rows.find((x) => x.name === name);
  if (!r) throw new Error(`行が無い: ${name} (ある行: ${rows.map((x) => x.name).join(",")})`);
  return r;
}

/** 画面が表示する差分。ReconcileForm と同じ式（実残高 − 自動算出） */
const diffOf = (r: { computed: number; actual: number | null }) =>
  r.actual == null ? null : r.actual - r.computed;

const snapRows = async (walletId?: number) => {
  const { rows } = await pool.query(
    walletId
      ? `SELECT wallet_id, to_char(as_of_date,'YYYY-MM-DD') d, actual_balance FROM balance_snapshots WHERE wallet_id=$1 ORDER BY as_of_date`
      : `SELECT wallet_id, to_char(as_of_date,'YYYY-MM-DD') d, actual_balance FROM balance_snapshots ORDER BY wallet_id, as_of_date`,
    walletId ? [walletId] : []
  );
  return rows as { wallet_id: string | number; d: string; actual_balance: number }[];
};

const initialBalance = async (walletId: number) =>
  (await pool.query("SELECT initial_balance FROM wallets WHERE id=$1", [walletId])).rows[0]
    .initial_balance as number;

/** crypto ウォレットを1つ足す */
async function addCrypto(name: string, initial = 0) {
  const r = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets)
     VALUES ($1,$2,'crypto',$3,true) RETURNING id`,
    [ids.userId, name, initial]
  );
  ids.wallet[name] = r.rows[0].id;
  return r.rows[0].id as number;
}

async function transfer(from: string, to: string, amount: number, fee: number, date: string) {
  await pool.query(
    `INSERT INTO transfers (user_id, from_wallet_id, to_wallet_id, amount, fee, kind, transfer_date)
     VALUES ($1,$2,$3,$4,$5,'transfer',$6)`,
    [ids.userId, ids.wallet[from], ids.wallet[to], amount, fee, date]
  );
}

/** もう1人ユーザーを作る（所有権チェックの検証用） */
async function otherUser() {
  const u = await pool.query(
    `INSERT INTO users (email, display_name, fiscal_year_start_month)
     VALUES ('other@example.com','他人',4) RETURNING id`
  );
  const uid: number = u.rows[0].id;
  const w = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance) VALUES ($1,'他人の銀行','bank',999999) RETURNING id`,
    [uid]
  );
  return { userId: uid, walletId: w.rows[0].id as number };
}

// 002 は BEGIN/COMMIT を含むのでテスト内では外して流す（既存テストと同じ扱い）
const SYNC_SQL = readFileSync("db/cleanup/002_sync_initial_balance.sql", "utf8")
  .replace(/^BEGIN;$/m, "")
  .replace(/^COMMIT;$/m, "");

beforeEach(async () => {
  ids = await resetDb();
});
afterAll(async () => {
  await pool.end();
});

// ============================================================
describe("照合画面の算出残高（getReconcileData）", () => {
  it("取引が無ければ算出残高＝期首残高、実残高は未記録", async () => {
    const rows = await getReconcileData();
    // is_balance_tracked=true の3つ。type順（bank→cash→credit_card）
    expect(rows.map((r) => r.name)).toEqual(["銀行A", "現金", "クレカA"]);
    expect(rows.map((r) => r.computed)).toEqual([500000, 20000, 0]);
    expect(rows.every((r) => r.actual === null && r.as_of === null)).toBe(true);
    expect(rows.map((r) => diffOf(r))).toEqual([null, null, null]);
  });

  it("脚・振替が算出残高に正しく効く（手数料は出金側から引かれる）", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "銀行A" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 120000, date: "2026-09-25", wallet: "銀行A" });
    await transfer("銀行A", "現金", 50000, 220, "2026-09-28");

    // 500,000 − 30,000 + 120,000 − (50,000+220) = 539,780
    expect((await row("銀行A")).computed).toBe(539780);
    // 20,000 + 50,000 = 70,000（手数料は受取側では引かれない）
    expect((await row("現金")).computed).toBe(70000);
  });

  it("実残高を記録すると差分が具体的な金額で出る", async () => {
    await addTx(ids, { category: "食料品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "銀行A" });
    const res = await record("2026-09-30", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 476500 }]);
    expect(res.status).toBe(200);

    const r = await row("銀行A");
    expect(r.computed).toBe(470000); // 500,000 − 30,000
    expect(r.actual).toBe(476500);
    expect(r.as_of).toBe("2026-09-30");
    expect(diffOf(r)).toBe(6500); // 6,500円の記入漏れがある、と画面が言う
  });

  it("記録して一致させた後に取引を足すと、その額ちょうど差が開く", async () => {
    await record("2026-09-30", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 500000 }]);
    expect(diffOf(await row("銀行A"))).toBe(0);

    await addTx(ids, { category: "外食", type: "expense", amount: 2500, date: "2026-10-01", wallet: "銀行A" });
    const r = await row("銀行A");
    expect(r.computed).toBe(497500);
    expect(diffOf(r)).toBe(2500); // 実残高の記録は動いていないので差が再び開く
  });

  it("他ユーザーのウォレットは画面に出ない", async () => {
    await otherUser();
    const rows = await getReconcileData();
    expect(rows.map((r) => r.name)).toEqual(["銀行A", "現金", "クレカA"]);
  });

  it("実残高は最新の基準日のものを見る（古い記録に引きずられない）", async () => {
    await record("2026-09-30", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 700000 }]);
    await record("2026-08-31", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 111111 }]); // 後から古い日を記録
    const r = await row("銀行A");
    expect(r.actual).toBe(700000);
    expect(r.as_of).toBe("2026-09-30");
    expect((await snapRows(ids.wallet["銀行A"])).length).toBe(2); // 両方DBには残る
  });

  it("カード未払いは負の算出残高として出る（サマリのカード未払いと符号が逆）", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
    const card = await row("クレカA");
    const a = await getAssets();
    expect(card.computed).toBe(-30000);
    expect(a.card_unpaid).toBe(30000);
    expect(card.computed).toBe(-a.card_unpaid); // 内部整合
  });
});

// ============================================================
describe("スナップショットの記録（POST /api/snapshots）", () => {
  it("同じ日に2回記録しても行は増えず、後の値で上書きされる（冪等）", async () => {
    const w = ids.wallet["銀行A"];
    expect((await record("2026-09-30", [{ wallet_id: w, actual_balance: 600000 }])).status).toBe(200);
    expect((await record("2026-09-30", [{ wallet_id: w, actual_balance: 610000 }])).status).toBe(200);

    const s = await snapRows(w);
    expect(s.length).toBe(1);
    expect(s[0].actual_balance).toBe(610000);
    expect((await row("銀行A")).actual).toBe(610000);
  });

  it("基準日が違えば別の記録として積まれる", async () => {
    const w = ids.wallet["銀行A"];
    await record("2026-09-30", [{ wallet_id: w, actual_balance: 600000 }]);
    await record("2026-10-31", [{ wallet_id: w, actual_balance: 640000 }]);
    expect((await snapRows(w)).map((x) => [x.d, x.actual_balance])).toEqual([
      ["2026-09-30", 600000],
      ["2026-10-31", 640000],
    ]);
    expect((await row("銀行A")).as_of).toBe("2026-10-31");
  });

  it("複数ウォレットを1回で記録できる", async () => {
    const res = await record("2026-09-30", [
      { wallet_id: ids.wallet["銀行A"], actual_balance: 480000 },
      { wallet_id: ids.wallet["現金"], actual_balance: 13500 },
    ]);
    expect(await res.json()).toEqual({ ok: true, count: 2 });
    expect((await row("銀行A")).actual).toBe(480000);
    expect((await row("現金")).actual).toBe(13500);
  });

  it("不正な入力は400で弾かれ、1件も記録されない", async () => {
    const w = ids.wallet["銀行A"];
    expect((await record("2026-9-30", [{ wallet_id: w, actual_balance: 1 }])).status).toBe(400); // 0埋め無し
    expect((await record("", [{ wallet_id: w, actual_balance: 1 }])).status).toBe(400);
    expect((await record("2026-09-30", [])).status).toBe(400);
    expect((await post("{壊れたJSON")).status).toBe(400);
    // 数値にならない実残高だけの場合も items が空になって400
    expect((await record("2026-09-30", [{ wallet_id: w, actual_balance: "abc" }])).status).toBe(400);
    expect((await snapRows()).length).toBe(0);
  });

  it("実残高は四捨五入して整数で保存される", async () => {
    await record("2026-09-30", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 1234.6 }]);
    expect((await row("銀行A")).actual).toBe(1235);
  });

  // ---- ここから現状の記録（望ましい挙動ではない） ----

  it("【現状の記録】書けなかったウォレットも成功件数に数えられる（他人のウォレット）", async () => {
    const other = await otherUser();
    const res = await record("2026-09-30", [
      { wallet_id: ids.wallet["銀行A"], actual_balance: 111 },
      { wallet_id: other.walletId, actual_balance: 222 }, // 所有者が違うので0行INSERT
    ]);
    const body = await res.json();

    // 所有権チェック自体は効いている（他人のデータは汚さない）＝ここは正しい
    expect(res.status).toBe(200);
    expect((await snapRows(other.walletId)).length).toBe(0);

    // これは現状の記録であり、望ましい挙動ではない：
    // 実際に書けたのは1件なのに count=2 を返し、UIは「✓ 2件を記録しました」と表示する。
    expect(body).toEqual({ ok: true, count: 2 });
    expect((await snapRows()).length).toBe(1);
  });

  it("【現状の記録】存在しないウォレットIDは、何も起きないのに成功扱いになる", async () => {
    const res = await record("2026-09-30", [{ wallet_id: 999999, actual_balance: 50000 }]);
    // これは現状の記録であり、望ましい挙動ではない：404/400 で知らせるべき場面
    expect(await res.json()).toEqual({ ok: true, count: 1 });
    expect((await snapRows()).length).toBe(0);
  });

  it("【現状の記録】同一ウォレットを2件送ると、1行しか残らないのに count=2 になる", async () => {
    const w = ids.wallet["銀行A"];
    const res = await record("2026-09-30", [
      { wallet_id: w, actual_balance: 100 },
      { wallet_id: w, actual_balance: 200 },
    ]);
    expect(await res.json()).toEqual({ ok: true, count: 2 });
    const s = await snapRows(w);
    expect(s.length).toBe(1);
    expect(s[0].actual_balance).toBe(200); // 後勝ち
  });

  it("【現状の記録】actual_balance が null だと 0 として記録される", async () => {
    // Number(null) === 0 で Number.isFinite を通ってしまう。
    // 未入力のつもりの null が「残高0」という最も危険な値になる。
    expect(Number.isFinite(Number(null))).toBe(true);
    const res = await record("2026-09-30", [{ wallet_id: ids.wallet["銀行A"], actual_balance: null }]);
    expect(await res.json()).toEqual({ ok: true, count: 1 });
    expect((await row("銀行A")).actual).toBe(0);
    expect(diffOf(await row("銀行A"))).toBe(-500000); // 50万の差として画面に出る
  });

  it("【現状の記録】数値にならない項目は黙って捨てられる（混在時）", async () => {
    const res = await record("2026-09-30", [
      { wallet_id: ids.wallet["銀行A"], actual_balance: 480000 },
      { wallet_id: ids.wallet["現金"], actual_balance: "１３５００" }, // 全角＝Number()でNaN
    ]);
    // 2件送ったのに count=1。エラーにも警告にもならない。
    expect(await res.json()).toEqual({ ok: true, count: 1 });
    expect((await row("現金")).actual).toBeNull();
  });
});

// ============================================================
describe("is_balance_tracked=false のウォレット", () => {
  it("照合画面には出ないが、総資産には入り続ける（照合できない残高が残る）", async () => {
    // ADR-015: 現金の残高は管理しない。だが include_in_assets は true のまま。
    await pool.query("UPDATE wallets SET is_balance_tracked=false WHERE id=$1", [ids.wallet["現金"]]);
    await addTx(ids, { category: "外食", type: "expense", amount: 5000, date: "2026-09-12", wallet: "現金" });

    const rows = await getReconcileData();
    expect(rows.map((r) => r.name)).toEqual(["銀行A", "クレカA"]); // 現金は消える

    // 照合画面に出ている資産系の合計（クレカ除く）
    const shown = rows.filter((r) => r.type !== "credit_card").reduce((s, r) => s + r.computed, 0);
    const a = await getAssets();
    expect(shown).toBe(500000);
    expect(a.total_assets).toBe(515000); // 現金 20,000 − 5,000 が総資産にだけ乗っている
    // これは現状の記録：画面の合計と総資産が 15,000 ずれるが、画面からは直せない
    expect(a.total_assets - shown).toBe(15000);
  });

  it("停止したウォレットは照合対象から外れる（002の確認クエリと一覧が揃う）", async () => {
    // 以前は画面が is_active を見ておらず、002 の確認クエリ（is_activeで絞る）と
    // 一覧が食い違っていた（バグ）。照合対象の母集団を揃える。
    await pool.query("UPDATE wallets SET is_active=false WHERE id=$1", [ids.wallet["現金"]]);
    const rows = await getReconcileData();
    expect(rows.map((r) => r.name)).toEqual(["銀行A", "クレカA"]);
    expect(SYNC_SQL).toContain("w.is_active"); // 002 側も同じ条件で絞っている

    // ただし停止しても残高は総資産に残る（getAssets は is_active を見ない）。
    // 画面から照合できない 20,000 が残るので、停止前に残高を0にする運用が要る。
    const shown = rows.filter((r) => r.type !== "credit_card").reduce((s, r) => s + r.computed, 0);
    expect(shown).toBe(500000);
    expect((await getAssets()).total_assets).toBe(520000);
  });
});

// ============================================================
describe("crypto の扱い（残高はスナップショットが正 / ADR-043）", () => {
  it("評価額を記録すれば算出残高もスナップショットになり、差分は0になる", async () => {
    const eth = await addCrypto("ETH"); // initial_balance=0
    await record("2026-09-30", [{ wallet_id: eth, actual_balance: 520000 }]);

    // 資産側：crypto はスナップショットが「正」
    expect((await getWalletBalances()).find((b) => b.name === "ETH")?.balance).toBe(520000);
    expect((await getAssets()).total_assets).toBe(1040000); // 500,000 + 20,000 + 520,000

    // 照合画面も同じ計算をする。以前はここだけ集計ベース（initial+脚+振替）で
    // computed=0、評価額の全額 520,000 が「記入漏れ」と赤字表示されていた（バグ）。
    const r = await row("ETH");
    expect(r.computed).toBe(520000);
    expect(r.actual).toBe(520000);
    expect(r.as_of).toBe("2026-09-30");
    expect(diffOf(r)).toBe(0);

    // 内部整合：照合画面の資産側合計＝総資産
    const rows = await getReconcileData();
    const assetSide = rows.filter((x) => x.type !== "credit_card").reduce((s, x) => s + x.computed, 0);
    expect(assetSide).toBe(1040000);
    expect(assetSide).toBe((await getAssets()).total_assets);
  });

  it("002 を流しても crypto は触られず、差分は0のまま", async () => {
    const eth = await addCrypto("ETH");
    await record("2026-09-30", [{ wallet_id: eth, actual_balance: 520000 }]);
    await pool.query(SYNC_SQL);

    expect(await initialBalance(eth)).toBe(0); // 002 は crypto を対象外にする（正しい）
    // 002 の手順書の「差分が全て0になっていることを確認する」を crypto でも満たせる。
    // 以前は期首残高を触らない＝差分 520,000 が永久に消えなかった（バグ）。
    expect((await row("ETH")).computed).toBe(520000); // initial_balance に依存しない
    expect(diffOf(await row("ETH"))).toBe(0);
  });

  it("スナップショット後の振替は算出残高に加算され、差分はその振替ぶんだけになる", async () => {
    const eth = await addCrypto("ETH");
    await record("2026-09-30", [{ wallet_id: eth, actual_balance: 520000 }]);
    await transfer("銀行A", "ETH", 100000, 0, "2026-10-05"); // 評価額記録より後に購入

    // 資産側：スナップショット後の振替を加算するので 620,000（総資産は保存される）
    expect((await getWalletBalances()).find((b) => b.name === "ETH")?.balance).toBe(620000);
    expect((await getAssets()).total_assets).toBe(1040000); // 銀行400,000 + 現金20,000 + ETH620,000

    // 照合画面も 620,000。以前は振替だけを拾って computed=100,000、差 420,000 だった（バグ）。
    const r = await row("ETH");
    expect(r.computed).toBe(620000);
    expect(r.actual).toBe(520000); // 実残高は 9/30 時点の評価額のまま
    // 差は「9/30以降に買い増した 100,000 が評価額に反映されていない」ぶんだけ。
    // 他のウォレットと同じで、記録が古くなれば差が開く、という意味になる。
    expect(diffOf(r)).toBe(-100000);

    // 評価額を記録し直せば差分は0に戻せる（以前は何をしても0にできなかった）
    await record("2026-10-31", [{ wallet_id: eth, actual_balance: 620000 }]);
    const r2 = await row("ETH");
    expect(r2.computed).toBe(620000);
    expect(r2.as_of).toBe("2026-10-31");
    expect(diffOf(r2)).toBe(0);
  });

  it("【現状の記録】評価額を空欄で保存すると 0 で上書きされ、総資産から消える", async () => {
    // CryptoPanel のガードは Number("")===0 を通す（0以上なので弾かれない）
    const src = readFileSync("components/CryptoPanel.tsx", "utf8");
    expect(src).toContain("const v = Number(values[w.id]);");
    expect(src).toContain("if (!Number.isFinite(v) || v < 0)");
    const passesGuard = (raw: string) => {
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0;
    };
    expect(passesGuard("")).toBe(true); // 空欄が 0 として素通りする

    const eth = await addCrypto("ETH");
    await record("2026-09-30", [{ wallet_id: eth, actual_balance: 520000 }]);
    expect((await getAssets()).total_assets).toBe(1040000);

    // 同じ日に空欄で保存＝0で上書き（upsertなので元の評価額は失われる）
    await record("2026-09-30", [{ wallet_id: eth, actual_balance: Number("") }]);
    expect((await snapRows(eth)).map((x) => x.actual_balance)).toEqual([0]);
    expect((await getAssets()).total_assets).toBe(520000); // 52万が消える
  });
});

// ============================================================
describe("クレカの実残高入力（カットオーバーの罠）", () => {
  it("入力欄はマイナスを受け付ける（先頭の1つだけ・数字以外は落とす）", async () => {
    const src = readFileSync("components/ReconcileForm.tsx", "utf8");
    // 入力欄のサニタイズ（この行が変わったらこのテストを見直すこと）
    // 以前は /[^0-9]/g で数字だけに絞っており、符号が落ちていた（バグ）。
    expect(src).toContain('.replace(/[^0-9-]/g, "")');
    expect(src).toContain('.replace(/(?!^)-/g, "")');
    expect(src).not.toContain("[^0-9]"); // 数字だけに絞る古いサニタイズが復活していない

    const sanitize = (raw: string) => raw.replace(/[^0-9-]/g, "").replace(/(?!^)-/g, "");
    expect(sanitize("-30000")).toBe("-30000"); // 符号が残る＝カードの未払いを入力できる
    expect(sanitize("¥-30,000")).toBe("-30000"); // 記号・区切りは落ちるが符号は残る
    expect(sanitize("30000")).toBe("30000");
    expect(sanitize("--30000")).toBe("-30000"); // マイナスは先頭の1つだけ
    expect(sanitize("300-00")).toBe("30000"); // 途中のマイナスは落とす
    expect(sanitize("abc")).toBe("");

    // 保存時の数値化（ReconcileForm.save と同じ式）まで通して符号が生き残る
    const parse = (raw: string) => parseInt(sanitize(raw), 10) || 0;
    expect(parse("-30,000")).toBe(-30000);
  });

  it("カードに負の実残高を入れれば差分0になり、002を流しても純資産は動かない", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
    const before = await getAssets();
    expect(before).toEqual({ total_assets: 520000, card_unpaid: 30000, net_assets: 490000 });

    // 画面の「自動算出 ¥-30,000」と同じ符号で入力できるようになった
    await record("2026-09-30", [{ wallet_id: ids.wallet["クレカA"], actual_balance: -30000 }]);
    const r = await row("クレカA");
    expect(r.actual).toBe(-30000); // 負の実残高がそのまま保存される
    expect(r.computed).toBe(-30000);
    expect(diffOf(r)).toBe(0); // 未払いが一致している＝記入漏れ無し

    // 002 は差分0のウォレットを触らないので、期首残高も資産も動かない
    await pool.query(SYNC_SQL);
    expect(await initialBalance(ids.wallet["クレカA"])).toBe(0);
    expect(await getAssets()).toEqual(before);
    expect(diffOf(await row("クレカA"))).toBe(0);

    // 内部整合：照合画面のカード側 = −未払い、資産側＋カード側 = 純資産
    const rows = await getReconcileData();
    const assetSide = rows.filter((x) => x.type !== "credit_card").reduce((s, x) => s + x.computed, 0);
    const cardSide = rows.filter((x) => x.type === "credit_card").reduce((s, x) => s + x.computed, 0);
    expect(-cardSide).toBe(before.card_unpaid);
    expect(assetSide + cardSide).toBe(before.net_assets);
  });

  it("【現状の記録】カードの実残高を符号ごと間違えて002を流すと純資産が6万円ズレる", async () => {
    await addTx(ids, { category: "日用品", type: "expense", amount: 30000, date: "2026-09-10", wallet: "クレカA" });
    const before = await getAssets();
    expect(before).toEqual({ total_assets: 520000, card_unpaid: 30000, net_assets: 490000 });

    // 入力欄はマイナスを受け付けるようになったが、明細の「ご請求額 30,000」を
    // そのまま正の値で入れてしまう余地は残っている（APIにも002にも符号の検査は無い）
    await record("2026-09-30", [{ wallet_id: ids.wallet["クレカA"], actual_balance: 30000 }]);
    expect(diffOf(await row("クレカA"))).toBe(60000); // 30,000 − (−30,000)

    // 手順どおり 002 を流す（002 は crypto しか除外しないのでカードも同期対象）
    await pool.query(SYNC_SQL);

    expect(await initialBalance(ids.wallet["クレカA"])).toBe(60000);
    const after = await getAssets();
    // これは現状の記録であり、望ましい挙動ではない：
    // 未払い30,000が「未払い −30,000」に反転し、純資産が 490,000 → 550,000（+60,000）になる
    expect(after.card_unpaid).toBe(-30000);
    expect(after.net_assets).toBe(550000);
    expect(after.net_assets - before.net_assets).toBe(60000);
    // 画面上は「差分0」になるので、手順書のチェック（差分が全て0）を通過してしまう
    expect(diffOf(await row("クレカA"))).toBe(0);
  });
});

// ============================================================
describe("カットオーバー一巡（画面→API→002→画面）", () => {
  it("銀行・現金は手順どおりで差分が0になり、総資産が実残高の合計と一致する", async () => {
    // 9月中の取引がいくつか入っている状態
    await addTx(ids, { category: "家賃", type: "expense", amount: 98000, date: "2026-09-05", wallet: "銀行A" });
    await addTx(ids, { category: "給与収入(手取り)", type: "income", amount: 320000, date: "2026-09-25", wallet: "銀行A" });
    await addTx(ids, { category: "食料品", type: "expense", amount: 4300, date: "2026-09-12", wallet: "現金" });
    await transfer("銀行A", "現金", 30000, 110, "2026-09-20");

    // 500,000 − 98,000 + 320,000 − 30,110 = 691,890 / 20,000 − 4,300 + 30,000 = 45,700
    expect((await row("銀行A")).computed).toBe(691890);
    expect((await row("現金")).computed).toBe(45700);

    // 実際の通帳残高はこうだった（＝入力漏れが銀行に 8,110 / 現金に 700 ある）
    await record("2026-09-30", [
      { wallet_id: ids.wallet["銀行A"], actual_balance: 700000 },
      { wallet_id: ids.wallet["現金"], actual_balance: 45000 },
    ]);
    expect(diffOf(await row("銀行A"))).toBe(8110);
    expect(diffOf(await row("現金"))).toBe(-700);

    await pool.query(SYNC_SQL);

    // 手順3：差分が全て0
    const rows = await getReconcileData();
    for (const r of rows.filter((x) => x.actual != null)) expect(diffOf(r)).toBe(0);
    expect((await row("銀行A")).computed).toBe(700000);
    expect((await row("現金")).computed).toBe(45000);
    // 期首残高は差分ぶんだけ動く：500,000+8,110 / 20,000−700
    expect(await initialBalance(ids.wallet["銀行A"])).toBe(508110);
    expect(await initialBalance(ids.wallet["現金"])).toBe(19300);
    // 総資産 = 実残高の合計
    expect((await getAssets()).total_assets).toBe(745000);
  });

  it("同期後に再度002を流しても値は動かない（冪等）", async () => {
    await addTx(ids, { category: "家賃", type: "expense", amount: 98000, date: "2026-09-05", wallet: "銀行A" });
    await record("2026-09-30", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 700000 }]);
    await pool.query(SYNC_SQL);
    const once = await initialBalance(ids.wallet["銀行A"]);
    await pool.query(SYNC_SQL);
    await pool.query(SYNC_SQL);
    expect(await initialBalance(ids.wallet["銀行A"])).toBe(once);
    expect(diffOf(await row("銀行A"))).toBe(0);
  });

  it("照合画面の算出残高は、資産サマリの内訳と一致する（内部整合）", async () => {
    await addTx(ids, { category: "通信費", type: "expense", amount: 7700, date: "2026-09-08", wallet: "銀行A" });
    await addTx(ids, { category: "日用品", type: "expense", amount: 12000, date: "2026-09-09", wallet: "クレカA" });
    const rows = await getReconcileData();
    const a = await getAssets();

    const assetSide = rows.filter((r) => r.type !== "credit_card").reduce((s, r) => s + r.computed, 0);
    const cardSide = rows.filter((r) => r.type === "credit_card").reduce((s, r) => s + r.computed, 0);
    expect(assetSide).toBe(512300); // 492,300 + 20,000
    expect(a.total_assets).toBe(512300);
    expect(-cardSide).toBe(a.card_unpaid);
    expect(assetSide + cardSide).toBe(a.net_assets);
  });
});

// ============================================================
describe("基準日と算出残高の関係", () => {
  it("算出残高は基準日を一切見ない（未来日付の支出も引かれている）", async () => {
    // 10/1カットオーバー時点から見た未来。先に計上した来月の家賃などがこれにあたる
    // （POST /api/transactions にも /api/recurring/post にも未来日付の制限は無い）。
    await addTx(ids, { category: "家賃", type: "expense", amount: 40700, date: "2026-12-25", wallet: "銀行A" });
    // 9/30 の照合画面なのに、12/25 の支払いが既に引かれている
    expect((await row("銀行A")).computed).toBe(459300);
  });

  it("【現状の記録】未来日付の支出があると、期首残高がその分だけ過大に同期される", async () => {
    await addTx(ids, { category: "家賃", type: "expense", amount: 40700, date: "2026-12-25", wallet: "銀行A" });

    // 9/30 の通帳の実残高は 500,000（12/25の支払いはまだ起きていない）
    await record("2026-09-30", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 500000 }]);
    expect(diffOf(await row("銀行A"))).toBe(40700); // 記入漏れに見える

    await pool.query(SYNC_SQL);

    // 手順書のチェック（差分が全て0）は通ってしまう
    expect(diffOf(await row("銀行A"))).toBe(0);
    // これは現状の記録であり、望ましい挙動ではない：
    // 期首残高が 500,000 ではなく 540,700 になり、まだ払っていない 40,700 を資産に含めている
    expect(await initialBalance(ids.wallet["銀行A"])).toBe(540700);

    // 12/25 を過ぎて実残高を記録し直すと、取引は全て正しく入っているのに差が復活する
    await record("2026-12-31", [{ wallet_id: ids.wallet["銀行A"], actual_balance: 459300 }]);
    const r = await row("銀行A");
    expect(r.computed).toBe(500000);
    expect(diffOf(r)).toBe(-40700); // 恒久的に 40,700 過大
    expect((await getAssets()).total_assets).toBe(520000); // 実際は 479,300
  });
});

// ============================================================
describe("資産合計に含めないウォレット", () => {
  it("include_in_assets=false でも照合画面には出る（残高は追うが資産に入れない）", async () => {
    await pool.query("UPDATE wallets SET include_in_assets=false WHERE id=$1", [ids.wallet["現金"]]);
    const rows = await getReconcileData();
    expect(rows.map((r) => r.name)).toContain("現金");
    expect((await row("現金")).computed).toBe(20000);
    expect((await getAssets()).total_assets).toBe(500000); // 現金は資産合計に入らない（設計どおり）
  });
});

// ============================================================
describe("総資産の目標（getAssetTarget）", () => {
  const setTarget = (period: string, metric: string, amount: number) =>
    pool.query(
      `INSERT INTO targets (user_id, period, metric, amount) VALUES ($1,$2,$3,$4)`,
      [ids.userId, period, metric, amount]
    );

  it("未設定なら0を返す", async () => {
    expect(await getAssetTarget("2026-09-01")).toBe(0);
  });

  it("設定した額を数値で返す", async () => {
    await setTarget("2026-09-01", "total_assets", 12000000);
    const t = await getAssetTarget("2026-09-01");
    expect(t).toBe(12000000);
    expect(typeof t).toBe("number"); // 文字列だと達成率の計算が壊れる
  });

  it("他の指標（収入目標）と取り違えない", async () => {
    await setTarget("2026-09-01", "income", 800000);
    await setTarget("2026-09-01", "expense", 300000);
    expect(await getAssetTarget("2026-09-01")).toBe(0);
    await setTarget("2026-09-01", "total_assets", 12000000);
    expect(await getAssetTarget("2026-09-01")).toBe(12000000);
  });

  it("月が違えば拾わない", async () => {
    await setTarget("2026-09-01", "total_assets", 12000000);
    expect(await getAssetTarget("2026-10-01")).toBe(0);
  });

  it("他ユーザーの目標は拾わない", async () => {
    const other = await otherUser();
    await pool.query(
      `INSERT INTO targets (user_id, period, metric, amount) VALUES ($1,'2026-09-01','total_assets',99999999)`,
      [other.userId]
    );
    expect(await getAssetTarget("2026-09-01")).toBe(0);
  });
});
