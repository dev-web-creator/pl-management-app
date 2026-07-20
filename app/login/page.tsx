import Link from "next/link";
import { redirect } from "next/navigation";
import { authEnabled, googleEnabled, getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ログイン画面（ADR-032/037）
// Google設定済みなら「Googleでログイン」のみ、未設定ならパスワードログイン。
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // 認証が無効（env未設定）またはログイン済みならトップへ
  if (!authEnabled() || (await getSession())) redirect("/");
  const sp = await searchParams;
  const google = googleEnabled();

  const ERROR_MSG: Record<string, string> = {
    "1": "ユーザー名またはパスワードが違います",
    denied: "このGoogleアカウントには利用権限がありません（管理者に招待を依頼してください）",
    google: "Googleログインに失敗しました。もう一度お試しください",
  };
  const errMsg = sp.error ? ERROR_MSG[sp.error] ?? ERROR_MSG.google : null;

  return (
    <main className="login-main">
      <div className="login-card">
        <span className="brand">
          <span className="brand-logo" aria-hidden="true">
            🌱
          </span>
          My PL Ledger
        </span>
        <p className="text-sm text-[var(--muted)] m-0">
          個人PL管理・家計簿アプリにログイン
        </p>
        {errMsg && (
          <p className="login-error m-0" role="alert">
            {errMsg}
          </p>
        )}

        {google ? (
          <a href="/api/auth/google" className="google-btn">
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
            </svg>
            Googleでログイン
          </a>
        ) : null}
        {google && (
          <p className="text-[11px] text-[var(--muted)] m-0 text-center">
            ログイン／登録により<Link href="/legal/terms" className="underline">利用規約</Link>・
            <Link href="/legal/privacy" className="underline">プライバシーポリシー</Link>に同意したものとみなします。
          </p>
        )}
        {!google && (
          <form method="POST" action="/api/auth/login" className="flex flex-col gap-4 m-0">
            <label>
              ユーザー名
              <input name="username" autoComplete="username" required autoFocus />
            </label>
            <label>
              パスワード
              <input type="password" name="password" autoComplete="current-password" required />
            </label>
            <button type="submit">ログイン</button>
          </form>
        )}
        {!google && (
          <div className="flex items-center justify-center gap-3 text-[11px] text-[var(--muted)] mt-1">
            <Link href="/legal/terms" className="hover:underline">利用規約</Link>
            <span>·</span>
            <Link href="/legal/privacy" className="hover:underline">プライバシーポリシー</Link>
          </div>
        )}
      </div>
    </main>
  );
}
