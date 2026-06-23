import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Noto_Sans_JP } from "next/font/google";
import "./globals.css";
import TopNav from "@/components/TopNav";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  weight: ["400", "500", "600", "700", "800"],
});
const notoJp = Noto_Sans_JP({
  subsets: ["latin"],
  variable: "--font-noto-jp",
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "My PL Ledger — 個人PL管理",
  description: "個人向け損益・資産管理ダッシュボード",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className={`${jakarta.variable} ${notoJp.variable}`}>
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
