import { redirect } from "next/navigation";
import { authEnabled, getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ログイン画面（sumika 風の白カード＋コーラルのブランドタイル）
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // 認証が無効（env未設定）またはログイン済みならトップへ
  if (!authEnabled() || (await getSessionUser())) redirect("/");
  const sp = await searchParams;

  return (
    <main className="login-main">
      <form className="login-card" method="POST" action="/api/auth/login">
        <span className="brand">
          <span className="brand-logo" aria-hidden="true">
            🏠
          </span>
          My PL Ledger
        </span>
        <p className="text-sm text-[var(--muted)] m-0">
          個人PL管理・家計簿アプリにログイン
        </p>
        {sp.error && (
          <p className="login-error m-0" role="alert">
            ユーザー名またはパスワードが違います
          </p>
        )}
        <label>
          ユーザー名
          <input
            name="username"
            autoComplete="username"
            required
            autoFocus
          />
        </label>
        <label>
          パスワード
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit">ログイン</button>
      </form>
    </main>
  );
}
