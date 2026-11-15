import "server-only";
import { envSchema } from "@/lib/env";

/**
 * The only place that reads MAILBOX_ENC_KEY, MAILBOX_ENC_KEY_PREVIOUS and APP_PUBLIC_ORIGIN (guard test pins this).
 * Validated lazily: a missing or malformed key only disables connecting/using mailboxes; the app still builds and
 * the Pesquisa area works. The keys themselves are never logged, printed or returned to a client.
 */
export class MailboxKeyError extends Error {
  constructor(readonly code: "missing" | "malformed") {
    super(code === "missing" ? "mailbox encryption key is not configured" : "mailbox encryption key must be base64 of 32 bytes");
    this.name = "MailboxKeyError";
  }
}

/** current encrypts and decrypts; previous (optional, during a rotation) only decrypts. */
export type MailboxKeyRing = { current: Buffer; previous: Buffer | null };

export function getMailboxKey(): Buffer {
  return getMailboxKeys().current;
}

export function getMailboxKeys(): MailboxKeyRing {
  const raw = envSchema.shape.MAILBOX_ENC_KEY.parse(process.env.MAILBOX_ENC_KEY);
  if (!raw) throw new MailboxKeyError("missing");
  const prev = envSchema.shape.MAILBOX_ENC_KEY_PREVIOUS.parse(process.env.MAILBOX_ENC_KEY_PREVIOUS);
  return { current: parseMailboxKey(raw), previous: prev ? parseMailboxKey(prev) : null };
}

export function parseMailboxKey(raw: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new MailboxKeyError("malformed");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new MailboxKeyError("malformed");
  return key;
}

export function hasMailboxKey(): boolean {
  try {
    getMailboxKeys();
    return true;
  } catch {
    return false;
  }
}

/** The configured public origin of this deployment (unsubscribe links), unvalidated; see origin.ts. */
export function configuredPublicOrigin(): string | null {
  return envSchema.shape.APP_PUBLIC_ORIGIN.parse(process.env.APP_PUBLIC_ORIGIN) ?? null;
}

/**
 * The server half of the clock's real-send lock (D4, F4 Task 11): on only when SCHEDULER_REAL_SEND is exactly "1".
 * Absent by default; only the owner sets it, in the deployment, when he says so. The other half is in the database
 * (C12 gate open and the emergency stop off, 0025). `source` exists so tests never have to set the variable.
 */
/** Name of the server env switch, for the owner-facing text (a label only; nothing reads it from here). */
export const REAL_SEND_ENV_NAME = "SCHEDULER_REAL_SEND";

export function realClockEnabled(source: Record<string, string | undefined> = process.env): boolean {
  return source.SCHEDULER_REAL_SEND === "1";
}
