import { z } from "zod";

/** Same shape the database accepts in join_waitlist (migration 0038): trimmed, 3 to 254 characters, name@host.tld. */
const emailSchema = z
  .string()
  .trim()
  .max(254)
  .regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/);

export type WaitlistInput = { ok: true; email: string } | { ok: false; reason: "honeypot" | "invalid" };

/** Reads the form: a filled honeypot field means a bot, anything that is not a plausible e-mail is invalid. */
export function parseWaitlist(formData: FormData): WaitlistInput {
  const trap = formData.get("website");
  if (typeof trap === "string" && trap.trim() !== "") return { ok: false, reason: "honeypot" };
  const parsed = emailSchema.safeParse(formData.get("email"));
  return parsed.success ? { ok: true, email: parsed.data } : { ok: false, reason: "invalid" };
}
