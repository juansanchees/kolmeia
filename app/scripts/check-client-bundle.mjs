// Runs after `next build` (part of `npm run check`). Fails if anything that must stay on the server reached the
// browser bundles: the Anthropic key's name or value shape, the SDK, the API host, the mailbox key, the mailbox
// ciphertext column, the mail transports, or the Places key and host.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../.next/static");
if (!existsSync(dir)) {
  console.error("check-client-bundle: .next/static not found (run next build first)");
  process.exit(1);
}
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
const forbidden = [/ANTHROPIC_API_KEY/, /sk-ant-[a-z0-9]/i, /api\.anthropic\.com/, /@anthropic-ai\/sdk/, /SERVICE_ROLE/i, /sb_secret_/, /MAILBOX_ENC_KEY/, /secret_ciphertext/, /smtp\.gmail\.com/, /imap\.gmail\.com/, /api\.apify\.com/, /api\.apollo\.io/, /api\.shovels\.ai/, /GOOGLE_PLACES_API_KEY/, /places\.googleapis\.com/];
const bad = [];
let scanned = 0;
for (const file of walk(dir)) {
  if (!/\.(js|mjs|cjs|map|json|html|css)$/.test(file)) continue;
  scanned++;
  const text = readFileSync(file, "utf8");
  for (const re of forbidden) if (re.test(text)) bad.push(`${path.relative(dir, file)}: ${re}`);
}
if (bad.length) {
  console.error("check-client-bundle: server-only material found in client bundles:\n" + bad.join("\n"));
  process.exit(1);
}
console.log(`check-client-bundle: ok (${scanned} files, nothing server-only in .next/static)`);
