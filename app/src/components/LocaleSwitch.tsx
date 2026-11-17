"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocaleAction } from "@/lib/i18n/actions";
import { htmlLang, LOCALE_NAMES, LOCALES, type Locale } from "@/lib/i18n";
import { useLocale, useT } from "@/lib/i18n/client";

/** "PT | EN" in the header: saves the choice in a cookie, then re-renders the page in that language. */
export function LocaleSwitch() {
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
    <div role="group" aria-label={t.locale.label} className="flex border border-line">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={htmlLang(l)}
          aria-label={LOCALE_NAMES[l]}
          title={LOCALE_NAMES[l]}
          aria-pressed={l === locale}
          disabled={pending}
          onClick={() => pick(l)}
          className={`min-h-11 min-w-11 px-2 font-mono text-xs uppercase ${l === locale ? "bg-ink text-surface" : "text-muted hover:text-ink"} disabled:opacity-60`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
