import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getMailboxKeys, type MailboxKeyRing } from "./config";

// Mailbox app passwords at rest: AES-256-GCM, random 96-bit IV, 128-bit tag, bound to the workspace and address
// through the additional authenticated data (a ciphertext copied to another row does not decrypt).
// Format: "v2:" + keyId + ":" + base64(iv | tag | ciphertext). keyId = first 8 hex of sha256(key): it names the
// key without revealing it, so the key can be rotated (config.ts: current key + optional previous key; old rows
// still decrypt until each mailbox is reconnected). "v1:" + base64(...) rows (no key id) are still read.
// Plaintext lives only in memory, for one SMTP/IMAP login.

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretError extends Error {
  /** format: not a ciphertext we know; tamper: authentication failed (wrong row/AAD, edited bytes or wrong key);
   *  key: written with a key this server no longer has (rotated out). Every case: reconnect the mailbox. */
  constructor(readonly code: "format" | "tamper" | "key") {
    super(code === "format" ? "secret has an unknown format" : code === "key" ? "secret was written with an unknown key" : "secret failed authentication");
    this.name = "SecretError";
  }
}

export function mailboxAad(workspaceId: string, email: string): string {
  return `mailbox:${workspaceId}:${email.trim().toLowerCase()}`;
}

export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function ring(keys: Buffer | MailboxKeyRing): Buffer[] {
  if (Buffer.isBuffer(keys)) return [keys];
  return [keys.current, ...(keys.previous ? [keys.previous] : [])];
}

export function encryptSecret(plain: string, aad: string, key: Buffer = getMailboxKeys().current): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v2:${keyId(key)}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

function open(raw: Buffer, aad: string, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

function payload(b64: string | undefined): Buffer {
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new SecretError("format");
  const raw = Buffer.from(b64, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new SecretError("format");
  return raw;
}

/** Decrypts with the current key, or the previous one during a rotation. */
export function decryptSecret(stored: string, aad: string, keys: Buffer | MailboxKeyRing = getMailboxKeys()): string {
  const parts = stored.split(":");
  const candidates = ring(keys);
  if (parts[0] === "v2" && parts.length === 3) {
    if (!/^[0-9a-f]{8}$/.test(parts[1])) throw new SecretError("format");
    const raw = payload(parts[2]);
    const key = candidates.find((k) => keyId(k) === parts[1]);
    if (!key) throw new SecretError("key");
    try {
      return open(raw, aad, key);
    } catch {
      throw new SecretError("tamper");
    }
  }
  if (parts[0] === "v1" && parts.length === 2) {
    const raw = payload(parts[1]);
    for (const key of candidates) {
      try {
        return open(raw, aad, key);
      } catch {
        // try the next key
      }
    }
    throw new SecretError("tamper");
  }
  throw new SecretError("format");
}
