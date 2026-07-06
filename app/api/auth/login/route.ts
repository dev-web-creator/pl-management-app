import { NextResponse } from "next/server";
import {
  passwordEnabled,
  checkCredentials,
  createSessionToken,
  appOrigin,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "@/lib/auth";

// パスワードログイン（Google未設定時のフォールバック）：オーナー(user 1)として入場
// リダイレクトは req.url でなく公開オリジン基準（App Runner等の内部アドレス対策）
export async function POST(req: Request) {
  const origin = appOrigin(req);
  if (!passwordEnabled()) {
    return NextResponse.redirect(`${origin}/`, 303);
  }
  const form = await req.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  if (!checkCredentials(username, password)) {
    return NextResponse.redirect(`${origin}/login?error=1`, 303);
  }

  const res = NextResponse.redirect(`${origin}/`, 303);
  res.cookies.set(SESSION_COOKIE, createSessionToken({ id: 1, email: username }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
