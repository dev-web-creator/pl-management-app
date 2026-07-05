// セッション認証（ADR-032 → ADR-037 でGoogleログイン＋マルチユーザー対応）
//
// 認証モード（envで自動切り替え）:
//  1. Googleログイン: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / AUTH_SECRET が揃うと有効。
//     ログイン画面は「Googleでログイン」のみになる（パスワード入力なし）。
//     入場許可 = users.email に登録済み or AUTH_ALLOWED_EMAILS（カンマ区切り）に含まれる
//     （後者は初回ログイン時に初期データつきでユーザー自動作成）。
//  2. パスワードログイン: AUTH_USER / AUTH_PASSWORD / AUTH_SECRET（Google未設定時のフォールバック）。
//  3. どちらも未設定なら認証オフ（ローカル開発・env設定前の本番を止めない）。
//
// セッションは HMAC-SHA256 署名付き Cookie。中身は {id, email, name, exp} のJSON。
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const SESSION_COOKIE = "pl_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30日

export type SessionUser = { id: number; email: string; name?: string };

export function googleEnabled(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.AUTH_SECRET
  );
}

export function passwordEnabled(): boolean {
  return !!(
    process.env.AUTH_USER &&
    process.env.AUTH_PASSWORD &&
    process.env.AUTH_SECRET
  );
}

export function authEnabled(): boolean {
  return googleEnabled() || passwordEnabled();
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
  if (!passwordEnabled()) return false;
  return (
    safeEqual(username, process.env.AUTH_USER!) &&
    safeEqual(password, process.env.AUTH_PASSWORD!)
  );
}

/** `<base64url(JSON)>.<署名>` 形式のセッショントークンを発行 */
export function createSessionToken(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Date.now() + SESSION_MAX_AGE * 1000 })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** トークンを検証し、有効ならユーザー情報を返す */
export function verifySessionToken(token: string | undefined): SessionUser | null {
  if (!token || !authEnabled()) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), sign(payload))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!d.exp || Date.now() > d.exp || !d.id || !d.email) return null;
    return { id: Number(d.id), email: String(d.email), name: d.name };
  } catch {
    return null;
  }
}

/** ログイン中のセッション（認証無効時・未ログイン時は null） */
export async function getSession(): Promise<SessionUser | null> {
  if (!authEnabled()) return null;
  const c = await cookies();
  return verifySessionToken(c.get(SESSION_COOKIE)?.value);
}

/** ナビ表示用のユーザー名（表示名 or メールアドレス） */
export async function getSessionUser(): Promise<string | null> {
  const s = await getSession();
  return s ? s.name || s.email : null;
}

/** データアクセスに使うユーザーID。認証無効時はオーナー(1)。 */
export async function currentUserId(): Promise<number> {
  if (!authEnabled()) return 1;
  return (await getSession())?.id ?? 1;
}

/** ページ用ガード：未ログインなら /login へリダイレクト */
export async function requireAuth(): Promise<void> {
  if (!authEnabled()) return;
  if (!(await getSession())) redirect("/login");
}

/** APIルート用ガード：未ログインなら 401 レスポンスを返す（認証OKなら null） */
export async function requireAuthApi(): Promise<Response | null> {
  if (!authEnabled()) return null;
  if (await getSession()) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** リクエストから公開オリジンを得る（Vercel等のプロキシ配下では x-forwarded-* を優先） */
export function appOrigin(req: Request): string {
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${proto}://${host}`;
}
