// テスト全体の安全ガード。
//
// db/schema.sql の先頭には DROP TABLE ... CASCADE がある。これを実データの入った
// pl_app に対して流すと取引が全消失する。事故を物理的に起こせなくするため、
// テストDBの名前が *_test で終わらない限り、テストの起動自体を止める。
import { beforeAll } from "vitest";

const url = process.env.DATABASE_URL ?? "";

function dbNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

const dbName = dbNameOf(url);

if (!url) {
  throw new Error("[テスト中止] DATABASE_URL が未設定です。");
}
if (!dbName.endsWith("_test")) {
  throw new Error(
    `[テスト中止] テストDB名が "_test" で終わっていません (db=${dbName})。\n` +
      `実データのDBを破壊する恐れがあるため実行を停止しました。\n` +
      `vitest.config.ts の DATABASE_URL を確認してください。`
  );
}

beforeAll(() => {
  // 何を相手にテストしているのか、実行ログに必ず残す
  console.log(`[テストDB] ${dbName}`);
});
