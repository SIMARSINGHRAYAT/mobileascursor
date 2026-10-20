import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mobile as Cursor",
  description: "Turn your smartphone into a wireless mouse for your computer.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-slate-100 antialiased">{children}</body>
    </html>
  );
}
