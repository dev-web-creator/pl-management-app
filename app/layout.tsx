import type { Metadata } from "next";
import { Zen_Maru_Gothic } from "next/font/google";
import "./globals.css";
import TopNav from "@/components/TopNav";
import { getSessionUser } from "@/lib/auth";

// 丸ゴシックで sumika の「Warm Kakeibo」の温かさを再現
const zenMaru = Zen_Maru_Gothic({
  subsets: ["latin"],
  variable: "--font-zen-maru",
  weight: ["400", "500", "700", "900"],
});

export const metadata: Metadata = {
  title: "My PL Ledger — 個人PL管理",
  description: "個人向け損益・資産管理ダッシュボード",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const username = await getSessionUser();
  return (
    <html lang="ja" className={zenMaru.variable}>
      <body>
        <TopNav username={username} />
        {children}
      </body>
    </html>
  );
}
