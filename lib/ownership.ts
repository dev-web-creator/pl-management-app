// 他人のウォレット・費目を自分の取引に使えてしまう問題への対処（ADR-004/037のマルチユーザー分離）。
//
// 背景: 書き込みAPIの多くは body の wallet_id / category_id をそのままINSERTしており、
// それが呼び出しユーザーのものかを確認していなかった。ADR-053でセルフサインアップを
// 開放しているため、IDは連番で推測でき、他人の口座を出金元にして自分の総資産を
// 増やすことができた（テストで再現済み）。
//
// 参照先IDは必ずこのモジュールで検証してからINSERT/UPDATEすること。
import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

/**
 * 指定のウォレットIDが全て自分のものなら true。空配列/null要素のみなら true。
 * 注意: bigint列は node-postgres が文字列で返すため、数値へ正規化してから照合する。
 * ここで「数値でないものを除外」すると検証が静かに素通りするので、必ず変換する。
 */
export async function ownsWallets(q: Q, userId: number, walletIds: unknown[]): Promise<boolean> {
  const nums = walletIds
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) return false; // 数値化できない値は不正扱い
  const uniq = [...new Set(nums)];
  if (uniq.length === 0) return true;
  const { rows } = await q.query(
    `SELECT count(*)::int AS n FROM wallets WHERE user_id=$1 AND id = ANY($2::bigint[])`,
    [userId, uniq]
  );
  return rows[0].n === uniq.length;
}

/** 指定の費目IDが自分のものなら true。null/undefined は true（任意項目のため）。 */
export async function ownsCategory(q: Q, userId: number, categoryId?: unknown): Promise<boolean> {
  if (categoryId == null || categoryId === "") return true;
  const n = Number(categoryId);
  if (!Number.isFinite(n)) return false;
  const { rows } = await q.query(
    `SELECT 1 FROM categories WHERE user_id=$1 AND id=$2 LIMIT 1`,
    [userId, n]
  );
  return (rows.length ?? 0) > 0;
}

/** 参照先をまとめて検証し、問題があればエラー文言を返す（無ければ null）。 */
export async function checkRefs(
  q: Q,
  userId: number,
  refs: { walletIds?: unknown[]; categoryId?: unknown }
): Promise<string | null> {
  if (!(await ownsWallets(q, userId, refs.walletIds ?? []))) {
    return "指定された決済手段が見つかりません";
  }
  if (!(await ownsCategory(q, userId, refs.categoryId))) {
    return "指定された費目が見つかりません";
  }
  return null;
}
