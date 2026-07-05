// セッション認証（ADR-032）
// AUTH_USER / AUTH_PASSWORD / AUTH_SECRET の3つが揃っているときだけ有効。
// 未設定なら全チェックが素通し＝ローカル開発や env 設定前の本番を止めない。
// セッションは HMAC-SHA256 署名付き Cookie（DBにセッションテーブルは持たない）。
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const SESSION_COOKIE = "pl_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30日

export function authEnabled(): boolean {
  return !!(
    process.env.AUTH_USER &&
    process.env.AUTH_PASSWORD &&
    process.env.AUTH_SECRET
  );
}

function sign(payload: string): string {
  return createHmac("sha256", process.env.AUTH_SECRET!)
    .update(payload)
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function checkCredentials(username: string, password: string): boolean {
  if (!authEnabled()) return false;
  return (
    safeEqual(username, process.env.AUTH_USER!) &&
    safeEqual(password, process.env.AUTH_PASSWORD!)
  );
}

/** `<username>.<有効期限ms>.<署名>` 形式のトークンを発行 */
export function createSessionToken(username: string): string {
  const payload = `${username}.${Date.now() + SESSION_MAX_AGE * 1000}`;
  return `${payload}.${sign(payload)}`;
}

/** トークンを検証し、有効ならユーザー名を返す */
export function verifySessionToken(token: string | undefined): string | null {
  if (!token || !authEnabled()) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), sign(payload))) return null;
  const j = payload.lastIndexOf(".");
  if (j < 0) return null;
  const exp = Number(payload.slice(j + 1));
  if (!exp || Date.now() > exp) return null;
  return payload.slice(0, j);
}

/** ログイン中のユーザー名（認証無効時・未ログイン時は null） */
export async function getSessionUser(): Promise<string | null> {
  if (!authEnabled()) return null;
  const c = await cookies();
  return verifySessionToken(c.get(SESSION_COOKIE)?.value);
}

/** ページ用ガード：未ログインなら /login へリダイレクト */
export async function requireAuth(): Promise<void> {
  if (!authEnabled()) return;
  if (!(await getSessionUser())) redirect("/login");
}

/** APIルート用ガード：未ログインなら 401 レスポンスを返す（認証OKなら null） */
export async function requireAuthApi(): Promise<Response | null> {
  if (!authEnabled()) return null;
  if (await getSessionUser()) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
