"use client";

import { createContext, use } from "react";
import { messagesFor, type Locale, type Messages } from ".";

const LocaleContext = createContext<Locale>("pt");

/** Set once in the root layout from the cookie; client components read it with useT(). */
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}

export const useLocale = (): Locale => use(LocaleContext);

export const useT = (): Messages => messagesFor(useLocale());
