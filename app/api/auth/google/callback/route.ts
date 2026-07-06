import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import pool from "@/lib/db";
import {
  googleEnabled,
  appOrigin,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "@/lib/auth";
import { provisionUser } from "@/lib/provision";

// Googleログインのコールバック（ADR-037）
// 1. state 検証（CSRF）→ 2. 認可コードをトークンに交換 → 3. id_token からメール取得
// 4. 許可判定（users.email 登録済み or AUTH_ALLOWED_EMAILS → 自動プロビジョニング）
// 5. セッションCookie発行
export async function GET(req: Request) {
  // リダイレクト先は req.url でなく公開オリジンから組み立てる
  // （App Runner等では req.url のホストが内部アドレス 0.0.0.0:3000 になるため）
  const origin = appOrigin(req);
  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/login?error=${reason}`, 303);
  if (!googleEnabled()) return NextResponse.redirect(`${origin}/login`, 303);

  const sp = new URL(req.url).searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  const c = await cookies();
  const savedState = c.get("pl_oauth_state")?.value;
  if (!code || !state || !savedState || state !== savedState) return fail("google");

  // 認可コード → トークン交換（Googleと直接TLS通信するため id_token は信頼できる）
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: appOrigin(req) + "/api/auth/google/callback",
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail("google");
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return fail("google");

  // id_token のペイロードを取り出し、audience と有効期限を確認
  let payload: { aud?: string; exp?: number; email?: string; email_verified?: boolean; name?: string };
  try {
    payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
  } catch {
    return fail("google");
  }
  if (
    payload.aud !== process.env.GOOGLE_CLIENT_ID ||
    !payload.exp ||
    payload.exp * 1000 < Date.now() ||
    !payload.email ||
    payload.email_verified === false
  ) {
    return fail("google");
  }
  const email = payload.email.toLowerCase();

  // 許可判定：
  //  1. AUTH_OWNER_EMAIL と一致 → オーナー(user 1)として入場（初回は users.email を書き換えて紐付け）
  //  2. users.email に登録済み → そのまま入場
  //  3. AUTH_ALLOWED_EMAILS に含まれる → 初期データつきでユーザー自動作成
  //  4. どれでもない → 拒否
  let userId: number;
  const ownerEmail = (process.env.AUTH_OWNER_EMAIL ?? "").trim().toLowerCase();
  const existing = await pool.query(`SELECT id FROM users WHERE lower(email)=$1`, [email]);
  if (email === ownerEmail && ownerEmail) {
    userId = 1;
    if (!existing.rowCount) {
      await pool.query(`UPDATE users SET email=$1, display_name=COALESCE($2, display_name) WHERE id=1`, [
        email,
        payload.name ?? null,
      ]);
    }
  } else if (existing.rowCount) {
    userId = existing.rows[0].id;
  } else {
    const allowed = (process.env.AUTH_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(email)) return fail("denied");
    userId = await provisionUser(email, payload.name);
  }

  const res = NextResponse.redirect(`${origin}/`, 303);
  res.cookies.set(SESSION_COOKIE, createSessionToken({ id: userId, email, name: payload.name }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  res.cookies.set("pl_oauth_state", "", { path: "/", maxAge: 0 });
  return res;
}
