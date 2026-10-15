import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "项目簿 · 口述项目待办",
  description: "把每一次口述，变成有据可查的项目进展。仅本人可访问的项目与任务记录。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
