// 全テスト共通のフィクスチャ。
// 方針: 実データのコピーではなく「手計算で期待値を出せる最小セット」を作る。
// 金額は意図的に桁を散らし、合計の取り違え（二重計上・取りこぼし）を検出しやすくしている。
import pool from "@/lib/db";

export type Ids = {
  userId: number;
  cat: Record<string, number>;
  wallet: Record<string, number>;
};

const TABLES = [
  "notification_log",
  "notification_rules",
  "vision_notes",
  "balance_snapshots",
  "payslip_items",
  "payslips",
  "monthly_closings",
  "targets",
  "transaction_legs",
  "transactions",
  "transfers",
  "card_statements",
  "recurring_rules",
  "categories",
  "wallets",
  "users",
];

/** 全テーブルを空にし、連番もリセットする */
export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`
  );
}

/** 最小マスタを投入し、名前→IDの対応表を返す */
export async function seedMasters(): Promise<Ids> {
  const u = await pool.query(
    `INSERT INTO users (email, display_name, fiscal_year_start_month)
     VALUES ('test@example.com', 'テスト', 4) RETURNING id`
  );
  const userId: number = u.rows[0].id;

  const cat: Record<string, number> = {};
  async function addCat(
    name: string,
    plType: string,
    parent: string | null = null,
    inputAllowed = true
  ) {
    const r = await pool.query(
      `INSERT INTO categories (user_id, parent_id, name, pl_type, is_input_allowed)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, parent ? cat[parent] : null, name, plType, inputAllowed]
    );
    cat[name] = r.rows[0].id;
    return cat[name];
  }

  // 収入
  await addCat("収入", "income", null, false);
  await addCat("給与収入(手取り)", "income", "収入");
  await addCat("副業収入", "income", "収入");
  // 固定費
  await addCat("固定費", "fixed_cost", null, false);
  await addCat("家賃", "fixed_cost", "固定費");
  await addCat("通信費", "fixed_cost", "固定費");
  await addCat("年額サブスク", "fixed_cost", "固定費");
  // 変動費（2階層のネストを持たせ、ロールアップの二重計上を検出できるようにする）
  await addCat("変動費", "variable_cost", null, false);
  await addCat("食費", "variable_cost", "変動費", false);
  await addCat("食料品", "variable_cost", "食費");
  await addCat("外食", "variable_cost", "食費");
  await addCat("日用品", "variable_cost", "変動費");
  // 控除・対象外
  await addCat("控除", "deduction", null, false);
  await addCat("社会保険料", "deduction", "控除");
  await addCat("対象外", "excluded", null, false);
  await addCat("投資", "excluded", "対象外");

  const wallet: Record<string, number> = {};
  const bank = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets)
     VALUES ($1,'銀行A','bank',500000,true) RETURNING id`,
    [userId]
  );
  wallet["銀行A"] = bank.rows[0].id;

  const cash = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets)
     VALUES ($1,'現金','cash',20000,true) RETURNING id`,
    [userId]
  );
  wallet["現金"] = cash.rows[0].id;

  // クレカ: 15日締め / 翌月10日払い / 引落先=銀行A
  const card = await pool.query(
    `INSERT INTO wallets (user_id, name, type, initial_balance, include_in_assets,
                          closing_day, payment_day, payment_month_offset, settlement_wallet_id)
     VALUES ($1,'クレカA','credit_card',0,true,15,10,1,$2) RETURNING id`,
    [userId, wallet["銀行A"]]
  );
  wallet["クレカA"] = card.rows[0].id;

  return { userId, cat, wallet };
}

/**
 * DBの「今日」を基準にした月初日（'YYYY-MM-DD'）。offset=0 が当月、-1 が先月、1 が来月。
 *
 * getFixedCostPlanVsActual などは過去月/当月の判定を Postgres の CURRENT_DATE で行うため、
 * 「当月」「未来月」を前提にするテストは日付を直書きせずこれで取得する。
 * （直書きすると、書いた日から月が変わった時点でテストが落ちる。2026-11 に実際に起きた）
 */
export async function monthStart(offset = 0): Promise<string> {
  const r = await pool.query(
    `SELECT to_char(date_trunc('month', CURRENT_DATE) + make_interval(months => $1::int), 'YYYY-MM-DD') AS m`,
    [offset]
  );
  return r.rows[0].m as string;
}

/** 月初日 'YYYY-MM-01' と日にちから 'YYYY-MM-DD' を作る */
export const dayOf = (monthFirst: string, day: number) =>
  `${monthFirst.slice(0, 8)}${String(day).padStart(2, "0")}`;

/** truncate + seed をまとめて実行 */
export async function resetDb(): Promise<Ids> {
  await truncateAll();
  return seedMasters();
}

/** 取引を1件作る（脚つき）。テストの可読性のためのショートカット。 */
export async function addTx(
  ids: Ids,
  opts: {
    category: string;
    type: "expense" | "income";
    amount: number;
    date: string;
    wallet?: string;
    clientKey?: string;
    memo?: string;
  }
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO transactions (user_id, category_id, type, amount, accrual_date, memo, client_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      ids.userId,
      ids.cat[opts.category],
      opts.type,
      opts.amount,
      opts.date,
      opts.memo ?? null,
      opts.clientKey ?? null,
    ]
  );
  const txId: number = r.rows[0].id;
  if (opts.wallet) {
    await pool.query(
      `INSERT INTO transaction_legs (transaction_id, wallet_id, amount) VALUES ($1,$2,$3)`,
      [txId, ids.wallet[opts.wallet], opts.amount]
    );
  }
  return txId;
}
