import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "IRQ Dashboard",
  description: "Sales CRM Dashboard with Turf Tracking",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-[#f7f8fa] text-[#0f172a] antialiased`}>{children}</body>
    </html>
  );
}
