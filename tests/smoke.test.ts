// ハーネス自体が機能するかの確認。
// これが通らない限り、他のテスト結果は信用できない。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb } from "./helpers/fixtures";

describe("テスト基盤のスモークテスト", () => {
  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("テストDBに接続でき、向き先が _test で終わるDBである", async () => {
    const r = await pool.query("select current_database() as db");
    expect(r.rows[0].db).toMatch(/_test$/);
    expect(r.rows[0].db).toBe(process.env.PLTEST_DB ?? "pl_app_test");
  });

  it("フィクスチャのマスタが投入されている", async () => {
    const c = await pool.query("select count(*)::int n from categories");
    const w = await pool.query("select count(*)::int n from wallets");
    const u = await pool.query("select count(*)::int n from users");
    expect(u.rows[0].n).toBe(1);
    expect(c.rows[0].n).toBe(16);
    expect(w.rows[0].n).toBe(3);
  });

  it("認証オフのため currentUserId() が cookies() を呼ばずに 1 を返す", async () => {
    const { currentUserId, authEnabled } = await import("@/lib/auth");
    expect(authEnabled()).toBe(false);
    await expect(currentUserId()).resolves.toBe(1);
  });
});
