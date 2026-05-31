import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PL管理アプリ",
  description: "個人向け損益・資産管理",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 text-gray-900">{children}</body>
    </html>
  );
}
