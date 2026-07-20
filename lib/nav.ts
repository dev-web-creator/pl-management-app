// ナビゲーション定義（ADR-046）
// TopNav と 設定画面（表示ON/OFF）で共有する。always=true のページは非表示にできない。
export type NavItem = { href: string; label: string; emoji: string; always?: boolean };

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "サマリ", emoji: "📊", always: true },
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
  { href: "/forecast", label: "5か年", emoji: "🔮" },
  { href: "/vision", label: "目標", emoji: "🌟" },
  { href: "/inspect", label: "DB", emoji: "🔍" },
  { href: "/settings", label: "設定", emoji: "⚙️", always: true },
];

export const HIDEABLE_HREFS = NAV_ITEMS.filter((n) => !n.always).map((n) => n.href);
