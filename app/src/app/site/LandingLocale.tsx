"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocaleAction } from "@/lib/i18n/actions";
import { htmlLang, LOCALE_NAMES, LOCALES, type Locale } from "@/lib/i18n";
import { useLocale, useT } from "@/lib/i18n/client";

/** PT | EN on the landing: same cookie and action as the app's switch, styled for the landing. */
export function LandingLocale() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const pick = (next: Locale) => {
    if (next === locale || pending) return;
    start(async () => {
      await setLocaleAction(next);
      router.refresh();
    });
  };
  return (
    <div className="lang" role="group" aria-label={t.landing.nav.language}>
      {LOCALES.map((l) => (
        <button key={l} type="button" lang={htmlLang(l)} aria-label={LOCALE_NAMES[l]} title={LOCALE_NAMES[l]} aria-pressed={l === locale} disabled={pending} onClick={() => pick(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
