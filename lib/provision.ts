// 新規ユーザーの自動作成（ADR-037）
// Googleログインで初めて入ってきた許可済みメールに対し、
// ユーザー行＋すぐ使い始められる最小限のマスタ（ウォレット・カテゴリ）を原子的に作る。
// カテゴリは汎用のスターターセット（オーナーの個人マスタはコピーしない）。
import pool from "@/lib/db";

type Cat = {
  name: string;
  pl: "income" | "fixed_cost" | "variable_cost" | "deduction" | "excluded";
  children?: string[]; // 子を持つ場合、親は集計ノード（入力不可）になる
};

const STARTER_CATEGORIES: Cat[] = [
  // 収入
  { name: "給与収入(手取り)", pl: "income" },
  { name: "その他収入", pl: "income" },
  // 控除（給与明細用）
  { name: "住民税", pl: "deduction" },
  { name: "所得税", pl: "deduction" },
  { name: "社会保険料", pl: "deduction" },
  // 固定費
  { name: "家賃", pl: "fixed_cost" },
  { name: "水道光熱費", pl: "fixed_cost" },
  { name: "通信費", pl: "fixed_cost" },
  { name: "サブスク", pl: "fixed_cost" },
  // 変動費（食費のみツリー・他は単独グループ）
  { name: "食費", pl: "variable_cost", children: ["朝飯", "昼飯", "晩飯", "外食", "スーパー"] },
  { name: "交際費", pl: "variable_cost" },
  { name: "日用品・買い物", pl: "variable_cost" },
  { name: "交通費", pl: "variable_cost" },
  { name: "趣味・娯楽", pl: "variable_cost" },
  { name: "その他", pl: "variable_cost" },
  // PL対象外
  { name: "経費立替", pl: "excluded" },
];

/** ユーザー＋初期マスタを作成し、新しい user id を返す */
export async function provisionUser(email: string, name?: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      `INSERT INTO users(email, display_name) VALUES ($1, $2) RETURNING id`,
      [email, name ?? null]
    );
    const uid = u.rows[0].id as number;

    // ウォレット：銀行・現金・クレカ（引落先=銀行）
    const bank = await client.query(
      `INSERT INTO wallets(user_id, name, type, display_order) VALUES ($1,'銀行口座','bank',1) RETURNING id`,
      [uid]
    );
    await client.query(
      `INSERT INTO wallets(user_id, name, type, is_balance_tracked, include_in_assets, display_order)
       VALUES ($1,'現金','cash',false,false,2)`,
      [uid]
    );
    await client.query(
      `INSERT INTO wallets(user_id, name, type, settlement_wallet_id, closing_eom, payment_day, payment_month_offset, display_order)
       VALUES ($1,'クレジットカード','credit_card',$2,true,27,1,3)`,
      [uid, bank.rows[0].id]
    );

    // カテゴリ（子持ちの親は入力不可の集計ノード）
    let order = 0;
    for (const c of STARTER_CATEGORIES) {
      order += 10;
      const hasChildren = !!c.children?.length;
      const p = await client.query(
        `INSERT INTO categories(user_id, name, pl_type, is_input_allowed, display_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [uid, c.name, c.pl, !hasChildren, order]
      );
      if (c.children) {
        let childOrder = 0;
        for (const ch of c.children) {
          childOrder += 1;
          await client.query(
            `INSERT INTO categories(user_id, parent_id, name, pl_type, display_order)
             VALUES ($1,$2,$3,$4,$5)`,
            [uid, p.rows[0].id, ch, c.pl, order + childOrder]
          );
        }
      }
    }

    await client.query("COMMIT");
    return uid;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
