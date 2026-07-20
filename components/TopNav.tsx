"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/nav";

export default function TopNav({
  username,
  hidden = [],
  isOwner = true,
}: {
  username: string | null;
  hidden?: string[];
  isOwner?: boolean; // /inspect はオーナーのみ（ADR-052）
}) {
  const pathname = usePathname() || "/";
  // ログイン画面ではナビを出さない
  if (pathname === "/login") return null;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  // 非表示設定（ADR-046）。閲覧中のページは設定に関わらず出す（迷子防止）
  // /inspect はオーナー専用なので他ユーザーには出さない（ADR-052）
  const items = NAV_ITEMS.filter(
    (n) =>
      (n.href !== "/inspect" || isOwner) &&
      (n.always || !hidden.includes(n.href) || isActive(n.href))
  );

  return (
    <nav className="nav">
      <Link href="/" className="brand">
        <span className="brand-logo" aria-hidden="true">
          🌱
        </span>
        <span className="hidden sm:inline">My PL Ledger</span>
      </Link>

      <div className="nav-links">
        {items.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            title={n.href === "/inspect" ? "DBインスペクター" : undefined}
            className={isActive(n.href) ? "active" : ""}
          >
            <span className="deco" aria-hidden="true">
              {n.emoji}
            </span>
            {n.label}
          </Link>
        ))}
      </div>

      {username && (
        <span className="nav-user">
          <span className="avatar" aria-hidden="true">
            🐥
          </span>
          <span className="hidden sm:inline">{username}</span>
          <form method="POST" action="/api/auth/logout">
            <button type="submit">ログアウト</button>
          </form>
        </span>
      )}
    </nav>
  );
}
