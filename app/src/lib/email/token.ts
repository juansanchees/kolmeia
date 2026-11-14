// Unsubscribe tokens: 64 hex characters made by the database (2 x gen_random_uuid(), 244 random bits), one per
// prospect. The public routes only accept this exact shape before calling unsubscribe_by_token().

export const UNSUB_TOKEN = /^[0-9a-f]{64}$/;

export function isUnsubToken(v: unknown): v is string {
  return typeof v === "string" && UNSUB_TOKEN.test(v);
}

/** Lower bound of the token's randomness in bits (each UUID v4 carries 122 random bits). */
export const UNSUB_TOKEN_RANDOM_BITS = 2 * 122;
