import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "จองตั๋วงานอีเวนต์",
  description: "แพลตฟอร์มจองและซื้อตั๋วงานอีเวนต์ ชำระเงินผ่าน PromptPay",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>
        <SiteHeader />
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
