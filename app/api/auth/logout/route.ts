import { NextResponse } from "next/server";
import { SESSION_COOKIE, appOrigin } from "@/lib/auth";

// ログアウト：セッションCookieを消して /login へ
// リダイレクトは req.url でなく公開オリジン基準（App Runner等の内部アドレス対策）
export async function POST(req: Request) {
  const res = NextResponse.redirect(`${appOrigin(req)}/login`, 303);
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
