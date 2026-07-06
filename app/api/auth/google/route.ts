import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { googleEnabled, appOrigin } from "@/lib/auth";

// Googleログイン開始（ADR-037）：state を発行して Google の認可画面へリダイレクト
export async function GET(req: Request) {
  if (!googleEnabled()) {
    return NextResponse.redirect(`${appOrigin(req)}/login`, 303);
  }
  const state = randomBytes(16).toString("hex");
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  auth.searchParams.set("redirect_uri", appOrigin(req) + "/api/auth/google/callback");
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("prompt", "select_account");

  const res = NextResponse.redirect(auth, 303);
  // CSRF対策：stateをCookieにも入れ、コールバックで一致を確認する
  res.cookies.set("pl_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
