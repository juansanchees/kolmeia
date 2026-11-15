// Where to go after sign-in. Same-origin invite paths only: anything else (open redirect) falls back to "/".
const INVITE_PATH = /^\/convite\/[0-9a-f]{64}$/;

export function safeNext(raw: unknown): string {
  return typeof raw === "string" && INVITE_PATH.test(raw) ? raw : "/";
}
