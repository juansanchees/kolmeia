import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, messagesFor, parseLocale, type Locale, type Messages } from ".";

/** The signed-in person's UI language (cookie kolmeia_locale), once per request. Request scope only. */
export const getLocale = cache(async (): Promise<Locale> => parseLocale((await cookies()).get(LOCALE_COOKIE)?.value));

export async function getT(): Promise<Messages> {
  return messagesFor(await getLocale());
}
