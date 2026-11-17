import type { Metadata } from "next";
import { fontVars } from "./fonts";
import { htmlLang } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/client";
import { getLocale, getT } from "@/lib/i18n/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t.appName, robots: { index: false, follow: false } };
}

// The UI language comes from the kolmeia_locale cookie (PT | EN switch in the header): every page renders per request.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={htmlLang(locale)} className={fontVars}>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
