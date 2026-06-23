"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "概要" },
  { href: "/transactions", label: "取引" },
  { href: "/transfers", label: "振替" },
  { href: "/fixed-costs", label: "固定費" },
  { href: "/payslips", label: "給与" },
  { href: "/cards", label: "カード" },
  { href: "/assets", label: "資産" },
  { href: "/budget", label: "予実" },
  { href: "/year", label: "年次" },
  { href: "/vision", label: "目標" },
];

export default function TopNav() {
  const pathname = usePathname() || "/";
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  return (
    <header className="sticky top-0 z-40 bg-[var(--ink)] text-white/90 border-b border-white/10 backdrop-blur">
      <div className="max-w-5xl mx-auto px-4">
        <div className="flex items-center gap-3 h-14">
          {/* ブランド */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="grid place-items-center w-7 h-7 rounded-md bg-[var(--positive)] text-[var(--ink)] font-extrabold text-xs tracking-tight">
              PL
            </span>
            <span className="font-extrabold tracking-tight text-white text-[15px] hidden sm:block">
              My&nbsp;PL <span className="text-white/40 font-medium">Ledger</span>
            </span>
          </Link>

          {/* ナビ（横スクロール対応） */}
          <nav className="flex-1 overflow-x-auto no-scrollbar">
            <ul className="flex items-center gap-1 text-sm whitespace-nowrap">
              {NAV.map((n) => {
                const active = isActive(n.href);
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      className={
                        "px-3 py-1.5 rounded-lg transition-colors " +
                        (active
                          ? "bg-white/10 text-white font-semibold"
                          : "text-white/55 hover:text-white hover:bg-white/5")
                      }
                    >
                      {n.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <Link
            href="/inspect"
            className="shrink-0 text-white/40 hover:text-white/80 text-xs"
            title="DBインスペクター"
          >
            ⌗ DB
          </Link>
        </div>
      </div>
    </header>
  );
}
