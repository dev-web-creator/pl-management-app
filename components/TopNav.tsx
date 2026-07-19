"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "概要", emoji: "📊" },
  { href: "/calendar", label: "カレンダー", emoji: "📅" },
  { href: "/transactions", label: "取引", emoji: "📒" },
  { href: "/transfers", label: "振替", emoji: "🔄" },
  { href: "/fixed-costs", label: "固定費", emoji: "📌" },
  { href: "/payslips", label: "給与", emoji: "💰" },
  { href: "/cards", label: "カード", emoji: "💳" },
  { href: "/assets", label: "資産", emoji: "🐷" },
  { href: "/budget", label: "予実", emoji: "🎯" },
  { href: "/weekly", label: "週次", emoji: "📆" },
  { href: "/year", label: "年次", emoji: "📈" },
  { href: "/analytics", label: "分析", emoji: "🧮" },
  { href: "/vision", label: "目標", emoji: "🌟" },
];

export default function TopNav({ username }: { username: string | null }) {
  const pathname = usePathname() || "/";
  // ログイン画面ではナビを出さない
  if (pathname === "/login") return null;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  return (
    <nav className="nav">
      <Link href="/" className="brand">
        <span className="brand-logo" aria-hidden="true">
          🌱
        </span>
        <span className="hidden sm:inline">My PL Ledger</span>
      </Link>

      <div className="nav-links">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? "active" : ""}>
            <span className="deco" aria-hidden="true">
              {n.emoji}
            </span>
            {n.label}
          </Link>
        ))}
        <Link href="/inspect" title="DBインスペクター" className={isActive("/inspect") ? "active" : ""}>
          <span className="deco" aria-hidden="true">
            🔍
          </span>
          DB
        </Link>
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
