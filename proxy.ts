import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// サイト全体をHTTP Basic認証で保護する（ADR-029）。
// Next.js 16 では従来の middleware は "proxy" に名称変更された（同じ仕組み）。
// 資格情報は環境変数で渡す:
//   BASIC_AUTH_USER / BASIC_AUTH_PASSWORD（Vercel の Environment Variables に設定）
// 両方が未設定のときは保護しない＝ローカル開発(npm run dev)はそのまま動く。
// /inspect も含めてこの認証の内側に置く（削除せず、見られる人を限定する）。
export function proxy(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASSWORD;

  // 未設定なら何もしない（=ローカルや未設定環境では素通り）
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    // "Basic base64(user:pass)" を分解して照合
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    if (u === user && p === pass) return NextResponse.next();
  }

  // 未認証 → ブラウザ標準のログインダイアログを出す
  return new NextResponse("認証が必要です", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="PL管理アプリ", charset="UTF-8"',
    },
  });
}

export const config = {
  // 静的ファイル・画像最適化・faviconは除外し、ページとAPIを保護する
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
