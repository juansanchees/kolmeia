import type { Metadata } from "next";
import { fontVars } from "./fonts";
import { t } from "@/messages/pt";
import "./globals.css";

export const metadata: Metadata = {
  title: t.appName,
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={fontVars}>
      <body>{children}</body>
    </html>
  );
}
