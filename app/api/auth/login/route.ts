import { NextResponse } from "next/server";
import {
  authEnabled,
  checkCredentials,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "@/lib/auth";

// ログイン：フォームPOST（username/password）→ 成功でセッションCookieを発行
export async function POST(req: Request) {
  if (!authEnabled()) {
    return NextResponse.redirect(new URL("/", req.url), 303);
  }
  const form = await req.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  if (!checkCredentials(username, password)) {
    return NextResponse.redirect(new URL("/login?error=1", req.url), 303);
  }

  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set(SESSION_COOKIE, createSessionToken(username), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
