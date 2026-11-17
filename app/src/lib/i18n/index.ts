// Locale plumbing shared by server and client. Server code reads the locale with ./server (getT), client
// components with ./client (useT). Pure functions that return copy take `t: Messages` as a parameter.
import { pt, type Messages } from "@/messages/pt";
import { en } from "@/messages/en";

export { fill } from "@/messages/fill";
export type { Messages };

export type Locale = "pt" | "en";
export const LOCALES: readonly Locale[] = ["pt", "en"];
/** Each language named in itself (never translated). */
export const LOCALE_NAMES: Record<Locale, string> = { pt: "Português", en: "English" };
export const LOCALE_COOKIE = "kolmeia_locale";

/** Cookie value to locale: only "en" switches; missing or anything else is Portuguese. */
export const parseLocale = (value: string | null | undefined): Locale => (value === "en" ? "en" : "pt");

export const messagesFor = (locale: Locale): Messages => (locale === "en" ? en : pt);

/** Portuguese messages for work outside a request (cron, background jobs) and content that stays in Portuguese. */
export const ptMessages: Messages = pt;

/** Value for <html lang>. */
export const htmlLang = (locale: Locale) => (locale === "en" ? "en" : "pt-BR");

/** The kolmeia_locale cookie: a year, whole site, sent on normal navigation. */
export const LOCALE_COOKIE_OPTIONS = { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", secure: process.env.NODE_ENV === "production" } as const;
