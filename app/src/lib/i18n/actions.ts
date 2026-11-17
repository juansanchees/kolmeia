"use server";

import { cookies } from "next/headers";
import { LOCALE_COOKIE, LOCALE_COOKIE_OPTIONS, parseLocale } from ".";

/** PT | EN switch: stores the UI language for a year. Anything but "en" stores "pt". */
export async function setLocaleAction(value: string): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, parseLocale(value), LOCALE_COOKIE_OPTIONS);
}
