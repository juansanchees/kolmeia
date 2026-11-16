import "server-only";
import { envSchema } from "@/lib/env";
import type { EmailQuality } from "./email-quality";

// Step 3 of the e-mail cascade (Fase 2, item 6): a paid verifier, chosen by EMAIL_VERIFIER. No vendor is wired in
// yet: the choice of service and its spend are the owner's. Default 'none' = the step is skipped.

export interface EmailVerifier {
  readonly name: string;
  /** One mailbox verdict. Must never send mail. */
  verify(email: string): Promise<EmailQuality>;
}

/** Implementations by EMAIL_VERIFIER value. Add a vendor here (and its key in env.ts) once the owner picks one. */
const VERIFIERS: Record<string, () => EmailVerifier> = {};

/** The only place that reads EMAIL_VERIFIER (a guard test pins this). Null = not configured ("none", empty or unknown). */
export function emailVerifier(name = envSchema.shape.EMAIL_VERIFIER.parse(process.env.EMAIL_VERIFIER), registry = VERIFIERS): EmailVerifier | null {
  if (!name || name === "none" || !Object.hasOwn(registry, name)) return null;
  return registry[name]();
}
