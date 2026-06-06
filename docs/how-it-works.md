# このアプリの仕組み（コード解剖ツアー）

> 目的：「どのコードが・どんなロジックで・どう数字を動かすか」を、実際のファイルを辿って理解する。
> 例として **「昼飯 ¥680 を PayPay残高 で入力する」** という1アクションが、画面→DB→画面と
> 一周する様子を、5つの層で追いかける。

---

## 0. 全体像：アプリは「5つの層」でできている

```
[① 画面/入力フォーム]  components/AddTransactionForm.tsx   ← ブラウザで動く(クライアント)
        │  POST(送信)
        ▼
[② 書き込みAPI]        app/api/transactions/route.ts       ← サーバーで動く
        │  INSERT
        ▼
[③ データベース]        db/schema.sql で定義した PostgreSQL  ← 事実だけ保存
        ▲
        │  SELECT(集計)
[④ 集計クエリ]          lib/queries.ts                       ← サーバーで動くSQL
        ▲
        │  計算結果
[⑤ 画面/ダッシュボード] app/page.tsx                         ← サーバーで描画(サーバーコンポーネント)
```

**最重要の考え方**：DBには「事実（取引1件1件）」だけを保存し、
**残高・PL・合計は保存しない**。表示のたびにSQLで“その場で計算”する（＝ADR-002）。
だから二重入力やズレが原理的に起きない。

---

## 1. 「クライアント」と「サーバー」── どこで動くか

Next.js（App Router）では、コードが動く場所が2種類ある。これが分かると全部読める。

- **サーバーコンポーネント**（既定）：サーバー上で実行され、**DBに直接アクセスできる**。
  実行結果のHTMLだけがブラウザに届く。例：`app/page.tsx`。
- **クライアントコンポーネント**：ファイル先頭に `"use client";` と書く。ブラウザで動き、
  クリックや入力など**対話**を担当する。DBには直接触れず、APIを呼ぶ。例：`AddTransactionForm.tsx`。

> なぜ分けるか：DBのパスワードや接続はサーバーに置きたい（ブラウザに晒さない）。
> だから「入力＝クライアント」「DB読み書き＝サーバー」と役割を分担する。

---

## 2. 層③：データベース ── `db/schema.sql`

ここが土台。`CREATE TABLE` で「箱（テーブル）」の形を定義している。
今回の主役は2つのテーブル：

### transactions（取引：何にいくら）
```sql
CREATE TABLE transactions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 主キー(背番号)
  user_id      bigint NOT NULL REFERENCES users(id) ...,        -- 外部キー(誰の)
  category_id  bigint NOT NULL REFERENCES categories(id) ...,   -- 外部キー(何の費目)
  type         text   NOT NULL CHECK (type IN ('expense','income')),
  amount       integer NOT NULL CHECK (amount > 0),  -- 総額(満額)
  accrual_date date    NOT NULL,                     -- 発生日＝PL計上日
  ...
);
```

### transaction_legs（支払い脚：どの手段でいくら）
```sql
CREATE TABLE transaction_legs (
  id             bigint ... PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, -- どの取引の脚か
  wallet_id      bigint NOT NULL REFERENCES wallets(id) ...,                    -- どのウォレットから
  amount         integer NOT NULL CHECK (amount > 0)
);
```

**用語を実物で：**
- **主キー (PK) `id`**：その行を一意に指す“背番号”。`GENERATED ALWAYS AS IDENTITY` で自動採番。
- **外部キー (FK) `transaction_id`**：別テーブル（transactions）の `id` を指す。
  「この脚はどの取引のものか」を結びつけ、**存在しない取引は指せない**（参照整合性）。
- **`ON DELETE CASCADE`**：親の取引を消すと、ぶら下がる脚も自動で消える（親子の連動）。

**なぜ取引と脚を分けるのか（ADR-025）**：1回の買い物を
「**何にいくら（＝transactions.amount 満額）**」と「**どう払ったか（＝legs 複数可）**」に分離。
カード¥8,000＋ポイント¥2,000の分割払いも、脚を2本にするだけで自然に表せる。
今回の昼飯は1手段なので**脚は1本**。

---

## 3. 層②：DBへの接続 ── `lib/db.ts`

アプリからDBに繋ぐ“配管”。アプリ全体で1つの接続プールを使い回す。
```ts
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export default pool;
```
- `pg` は Node.js から PostgreSQL を操作するライブラリ。
- `DATABASE_URL` は `.env.local` に記載：`postgresql://postgres@localhost:5432/pl_app`。
  **この1行を差し替えるだけで、接続先をローカル→クラウドのDBに変えられる**（デプロイの肝）。

---

## 4. 層④：集計クエリ ── `lib/queries.ts`

「事実から数字を計算する」頭脳。例として**ウォレット残高**の関数を読む。
```ts
export async function getWalletBalances() {
  const { rows } = await pool.query(
    `WITH legs AS (                       -- ①各ウォレットの「取引による増減」
       SELECT tl.wallet_id,
         SUM(CASE WHEN t.type='income' THEN tl.amount ELSE -tl.amount END) AS d
       FROM transaction_legs tl JOIN transactions t ON t.id = tl.transaction_id
       WHERE t.user_id = $1 GROUP BY tl.wallet_id
     ),
     tr_in  AS (...),                     -- ②振替で入ってきた分
     tr_out AS (...)                      -- ③振替で出ていった分
     SELECT w.name, w.type,
       (w.initial_balance + COALESCE(legs.d,0) + COALESCE(tr_in.a,0) - COALESCE(tr_out.a,0)) AS balance
     FROM wallets w
     LEFT JOIN legs ... LEFT JOIN tr_in ... LEFT JOIN tr_out ...`,
    [USER_ID]
  );
  return rows;
}
```
読み方：
- `WITH ... AS (...)` は **CTE**（一時的な集計の名前付け）。`legs` で「取引による増減」、
  `tr_in/tr_out` で「振替の出入り」を別々に出してから、最後に足し引きする。
- `CASE WHEN type='income' THEN +amount ELSE -amount` ＝ 収入は＋、支出は−。
- **残高 = 開始残高 + 取引増減 + 振替IN − 振替OUT**。残高カラムは存在せず、毎回これで算出。
- `$1` は **プレースホルダ**。値（USER_ID）を別で渡すことでSQLインジェクションを防ぐ安全な書き方。

> 同じ発想で `getPLSummary`（可処分所得−固定費−変動費＝月次黒字）や
> `getVariableGroups`（再帰SQLで朝/昼/晩→食費へロールアップ）も作ってある。
> 中身は `db/dev/queries.sql` に素のSQLとしても置いてあるので見比べると分かりやすい。

---

## 5. 層⑤：画面の描画 ── `app/page.tsx`（サーバーコンポーネント）

ページは `async function`。**サーバー上で**④の関数を呼んでデータを集め、HTMLにして返す。
```ts
export const dynamic = "force-dynamic"; // 毎回DBから最新を取得（キャッシュしない）

export default async function Home() {
  const [pl, wallets, assets, varGroups, inputCats, walletOpts] = await Promise.all([
    getPLSummary("2026-06-01"),
    getWalletBalances(),
    ...
  ]);
  return ( <main> ... {yen(pl.surplus)} ... </main> );
}
```
- `await Promise.all([...])` ＝ 複数のSQLを**同時並行**で投げて待つ（速い）。
- 取得した `pl`・`wallets` 等を、そのままJSX（HTMLのようなもの）に埋めて表示。
- `dynamic = "force-dynamic"` で「キャッシュせず毎回DBを見る」ので、入力直後の最新が出る。

---

## 6. 層①：入力フォーム ── `components/AddTransactionForm.tsx`（クライアント）

先頭に `"use client";`。ブラウザで動き、入力値を持ち、送信する。
```ts
const res = await fetch("/api/transactions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ category_id, type, amount: amt, accrual_date: date, wallet_id }),
});
const data = await res.json();
if (data.ok) router.refresh();   // ★サーバーコンポーネントを再取得＝全数字が更新
```
- `fetch(...POST...)` で②のAPIにデータを送る。
- 成功したら **`router.refresh()`**：これが「全連動」の見た目を作る正体。
  ページ（サーバーコンポーネント）を再実行→④の集計SQLが走り直し→新しい数字でHTML再描画。

---

## 7. 層②：書き込みAPI ── `app/api/transactions/route.ts`

フォームからのPOSTを受け、**検証してDBに安全に書く**。
```ts
export async function POST(req: Request) {
  const body = await req.json();
  // 1) 検証：必須項目・金額>0・「脚の合計＝金額」をチェック
  if (legSum !== Number(amount)) return NextResponse.json({ ok:false, error:"..." }, {status:400});

  // 2) DBトランザクションで“取引＋脚”を原子的に挿入
  const client = await pool.connect();
  try {
    await client.query("BEGIN");                          // 開始
    const txRes = await client.query(
      `INSERT INTO transactions(...) VALUES (...) RETURNING id`, [...]);
    const txId = txRes.rows[0].id;
    for (const leg of legs)
      await client.query(`INSERT INTO transaction_legs(...) VALUES ($1,$2,$3)`, [txId, leg.wallet_id, leg.amount]);
    await client.query("COMMIT");                          // 確定
  } catch (e) {
    await client.query("ROLLBACK");                        // 失敗時は全部取り消し
  } finally { client.release(); }
}
```
**DBトランザクション（BEGIN〜COMMIT）の意味**：
「取引を入れたが脚は入らなかった」という**中途半端な状態を絶対に残さない**。
途中で失敗したら `ROLLBACK` で全部なかったことにする（＝原子性 all-or-nothing）。

---

## 8. 通しトレース：「昼飯 ¥680 / PayPay残高」を入力すると何が起きるか

1. **フォーム(①)**：金額680・カテゴリ「昼飯」・決済「PayPay残高」を選び保存 → `POST /api/transactions`。
2. **API(②)**：検証OK（脚合計680＝金額680）→ `BEGIN` →
   `transactions` に1行（type=expense, amount=680, category_id=昼飯）→
   `transaction_legs` に1行（wallet=PayPay残高, amount=680）→ `COMMIT`。
3. **DB(③)**：事実が2行増えただけ。残高もPLも“数字としては”どこにも書いていない。
4. **再描画の合図**：フォームが `router.refresh()` を呼ぶ。
5. **画面(⑤)** が再実行され、**集計(④)** が走り直す：
   - `getWalletBalances`：PayPay残高 = …−680（昼飯ぶん減る）
   - `getVariableGroups`：昼飯→**食費(1人)→食費**へ自動で +680 ロールアップ
   - `getPLSummary`：変動費 +680、よって月次黒字 −680
6. 新しい数字でHTMLが返り、画面の該当箇所が**一斉に更新**される。

→ これが「1入力・全連動」の正体。**入れたのは“事実1件”だけ。残りは全部SQLが計算している。**

---

## 9. ここまでが分かると「デプロイ」も分かる

- 今のこのファイル群（`app/` `lib/` `db/`）が**アプリの実体**。あなたのPCが実行＝`localhost`。
- **デプロイ＝同じファイルをクラウドの常時動くマシンに置く**こと。コードは不変。
- DBも同じSQL・同じテーブルのまま、`DATABASE_URL` の接続先を
  ローカル→クラウドPostgreSQLに差し替えるだけ。
- → 次のステップ(b)で、これを実際に無料枠クラウドへ載せて、スマホからも開ける状態にする。
