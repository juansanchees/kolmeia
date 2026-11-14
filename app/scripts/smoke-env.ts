// Loads the Anthropic key for the real-API smoke scripts WITHOUT copying or printing it.
// SMOKE_ENV_FILE points at an env file by path (for example a sibling worktree's .env.local); default: ./.env.local.
// Nothing here logs, echoes or returns a value from that file; callers only get "is a key set?".
import { existsSync } from "node:fs";

export function loadSmokeEnv(): void {
  const file = process.env.SMOKE_ENV_FILE || ".env.local";
  if (!existsSync(file)) throw new Error("smoke: env file not found (set SMOKE_ENV_FILE)");
  process.loadEnvFile(file);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("smoke: no ANTHROPIC_API_KEY in the env file");
}

/** Removes anything that looks like a key from a string before it is logged. */
export function redact(s: string): string {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  return (key ? s.split(key).join("[key]") : s).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[key]").slice(0, 600);
}
