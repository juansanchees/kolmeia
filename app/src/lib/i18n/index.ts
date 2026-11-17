// Locale plumbing shared by server and client. Server code reads the locale with ./server (getT), client
// components with ./client (useT). Pure functions that return copy take `t: Messages` as a parameter.
import { pt, type Messages } from "@/messages/pt";
import { en } from "@/messages/en";

export { fill } from "@/messages/fill";
export type { Messages };

export type Locale = "pt" | "en";
export const LOCALE_COOKIE = "kolmeia_locale";

/** Cookie value to locale: only "en" switches; missing or anything else is Portuguese. */
export const parseLocale = (value: string | null | undefined): Locale => (value === "en" ? "en" : "pt");

export const messagesFor = (locale: Locale): Messages => (locale === "en" ? en : pt);

/** Portuguese messages for work outside a request (cron, background jobs) and content that stays in Portuguese. */
export const ptMessages: Messages = pt;

/** Value for <html lang>. */
export const htmlLang = (locale: Locale) => (locale === "en" ? "en" : "pt-BR");
