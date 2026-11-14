import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { env, envSchema } from "@/lib/env";

const root = path.resolve(import.meta.dirname, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("R14: no service-role key in the product", () => {
  test("the string SERVICE_ROLE does not appear in product/src (any case)", () => {
    for (const file of walk(path.join(root, "src"))) {
      expect(readFileSync(file, "utf8").toUpperCase(), file).not.toContain("SERVICE_ROLE");
    }
  });
  test(".env.example does not mention service_role, sb_secret_ or any SECRET / SERVICE variable", () => {
    const text = readFileSync(path.join(root, ".env.example"), "utf8");
    expect(text.toUpperCase()).not.toContain("SERVICE_ROLE");
    expect(text).not.toContain("sb_secret_");
    expect(text.toUpperCase()).not.toMatch(/SECRET|SERVICE/);
  });
  test("the migration grants nothing to service_role", () => {
    const sql = readdirSync(path.join(root, "supabase/migrations")).map((f) => readFileSync(path.join(root, "supabase/migrations", f), "utf8")).join("\n");
    expect(sql.toLowerCase()).not.toMatch(/service_role/);
  });
  test("no admin-key shapes in src (sb_secret_, env names with SECRET or SERVICE)", () => {
    for (const file of walk(path.join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("sb_secret_");
      expect(text, file).not.toMatch(/process\.env\.\w*(SECRET|SERVICE)/i);
      expect(text, file).not.toMatch(/\b[A-Z][A-Z0-9_]*(SECRET|SERVICE)[A-Z0-9_]*\b/);
    }
  });
  test("process.env is read only in src/lib/env.ts, the AI gateway config and the mailbox key config (NODE_ENV allowed)", () => {
    const allowed = [path.join(root, "src/lib/env.ts"), path.join(root, "src/lib/ai/config.ts"), path.join(root, "src/lib/email/config.ts")];
    for (const file of walk(path.join(root, "src"))) {
      if (allowed.includes(file)) continue;
      const uses = readFileSync(file, "utf8").match(/process\.env\b(?!\.NODE_ENV\b)/g);
      expect(uses, file).toBeNull();
    }
  });
  test("the env schema exposes the two public Supabase variables plus the server-only Anthropic key, AI caps and mailbox key", () => {
    expect(Object.keys(envSchema.shape).sort()).toEqual([
      "AI_GLOBAL_DAILY_CAP_USD",
      "AI_USER_DAILY_CAP_USD",
      "ANTHROPIC_API_KEY",
      "APP_PUBLIC_ORIGIN",
      "MAILBOX_ENC_KEY",
      "MAILBOX_ENC_KEY_PREVIOUS",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
    ]);
  });
  test("the public env object never carries the Anthropic key, the mailbox keys or the public origin", () => {
    expect(Object.keys(env).sort()).toEqual(["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"]);
  });
  test(".env.example lists exactly those eight variables, empty", () => {
    const lines = readFileSync(path.join(root, ".env.example"), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines.sort()).toEqual([
      "AI_GLOBAL_DAILY_CAP_USD=",
      "AI_USER_DAILY_CAP_USD=",
      "ANTHROPIC_API_KEY=",
      "APP_PUBLIC_ORIGIN=",
      "MAILBOX_ENC_KEY=",
      "MAILBOX_ENC_KEY_PREVIOUS=",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=",
      "NEXT_PUBLIC_SUPABASE_URL=",
    ]);
  });
  test("the AI caps are read only in src/lib/ai/config.ts and never reach the public env", () => {
    for (const file of walk(path.join(root, "src"))) {
      if (file === path.join(root, "src/lib/ai/config.ts") || file === path.join(root, "src/lib/env.ts")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(/AI_(USER|GLOBAL)_DAILY_CAP_USD/);
    }
    expect(Object.keys(env)).not.toContain("AI_USER_DAILY_CAP_USD");
  });
});

describe("ANTHROPIC_API_KEY stays on the server", () => {
  test("the key's name appears only in src/lib/env.ts (schema) and src/lib/ai/config.ts (the one reader)", () => {
    const allowed = [path.join(root, "src/lib/env.ts"), path.join(root, "src/lib/ai/config.ts")];
    for (const file of walk(path.join(root, "src"))) {
      if (allowed.includes(file)) continue;
      expect(readFileSync(file, "utf8"), file).not.toContain("ANTHROPIC_API_KEY");
    }
  });
  test("every file of the AI gateway and the research engine imports server-only (build fails if a client imports it)", () => {
    const serverFiles = [
      ...walk(path.join(root, "src/lib/ai")),
      path.join(root, "src/lib/research/engine.ts"),
      path.join(root, "src/lib/research/supabase-store.ts"),
      ...walk(path.join(root, "src/lib/hunter")),
      ...["net.ts", "reader.ts"].map((f) => path.join(root, "src/lib/qualifier/site", f)),
    ];
    for (const file of serverFiles) {
      expect(readFileSync(file, "utf8"), file).toMatch(/^import "server-only";/m);
    }
  });
  test("no client component imports the AI gateway or the SDK", () => {
    for (const file of walk(path.join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!/^["']use client["'];?/m.test(text)) continue;
      expect(text, file).not.toMatch(/@\/lib\/ai\/|@anthropic-ai\/sdk|research\/engine|supabase-store/);
    }
  });
  test("the SDK is only imported inside src/lib/ai", () => {
    for (const file of walk(path.join(root, "src"))) {
      if (file.startsWith(path.join(root, "src/lib/ai"))) continue;
      expect(readFileSync(file, "utf8"), file).not.toContain("@anthropic-ai/sdk");
    }
  });
  test("the build check script exists and is part of `npm run check`", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts.check).toContain("scripts/check-client-bundle.mjs");
  });
});

describe("R13: the AI has no tool that writes, sends or deletes", () => {
  test("only read-only server tools (web search, web fetch) are declared, and LinkedIn is blocked in both", () => {
    const text = readFileSync(path.join(root, "src/lib/ai/anthropic-transport.ts"), "utf8");
    // Declared tool types (finding 19 and the "0 companies" diagnosis: basic fetch and basic search; see
    // docs/mvp/fase-1-3-pesquisa.md).
    const types = [...text.matchAll(/type: "([a-z_]+_\d{8})"/g)].map((m) => m[1]).sort();
    expect(types).toEqual(["web_fetch_20250910", "web_search_20250305"]);
    expect(text).toMatch(/BLOCKED_DOMAINS = \["linkedin\.com", "lnkd\.in"\]/);
    expect(text.match(/blocked_domains: BLOCKED_DOMAINS/g)).toHaveLength(2);
    // Result blocks of code execution are READ (seenUrls); no such tool is ever declared.
    expect(text).not.toMatch(/type: "(code_execution|bash_code|text_editor|computer|memory)_\d|mcp_toolset|betaZodTool|toolRunner/);
  });
  test("no user-defined tools anywhere in the AI layer", () => {
    for (const file of walk(path.join(root, "src/lib/ai"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/input_schema|betaTool\(|tool_choice/);
    }
  });
});

describe("R11: no path to cold SMS or LinkedIn", () => {
  test("no dependency matches twilio / sms / linkedin", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
    expect(names.filter((n) => /twilio|sms|linkedin/i.test(n))).toEqual([]);
  });
  test("LinkedIn is named in src only where it is blocked (URL filter, web tools, prompt rule, agent review copy)", () => {
    const allowed = ["src/lib/safe-url.ts", "src/lib/ai/anthropic-transport.ts", "src/lib/ai/prompts/shared.ts", "src/messages/pt/agents.ts"].map((f) => path.join(root, f));
    for (const file of walk(path.join(root, "src"))) {
      if (allowed.includes(file)) continue;
      expect(readFileSync(file, "utf8").toLowerCase(), file).not.toContain("linkedin");
    }
  });
  test("the database rejects LinkedIn URLs in every URL column (check constraints in 0002)", () => {
    const sql = readFileSync(path.join(root, "supabase/migrations/0002_research.sql"), "utf8");
    for (const col of ["research_sources_url", "research_candidates_website", "research_candidates_name_source_url", "research_candidates_portal", "research_evidence_url"]) {
      expect(sql).toMatch(new RegExp(`constraint ${col} check \\(public\\.is_safe_url\\(`));
    }
    const sql4 = readFileSync(path.join(root, "supabase/migrations/0004_research_hardening.sql"), "utf8");
    for (const col of ["research_candidates_found_at_url", "research_candidates_phone_source_url", "research_candidates_email_source_url", "research_candidates_rating_source_url", "research_jobs_source_url"]) {
      expect(sql4).toMatch(new RegExp(`constraint ${col} check \\(public\\.is_safe_url\\(`));
    }
  });
});

describe("E-mail area: secrets, transports and AI stay on the server [R10] [R13] [R14]", () => {
  const email = (f: string) => path.join(root, "src/lib/email", f);
  const SERVER_FILES = ["config.ts", "crypto.ts", "transport.ts", "parse.ts", "engine.ts", "session.ts", "supabase-store.ts"].map(email);

  test("MAILBOX_ENC_KEY(_PREVIOUS) is named only in src/lib/env.ts (schema) and src/lib/email/config.ts (the one reader)", () => {
    const allowed = [path.join(root, "src/lib/env.ts"), email("config.ts")];
    for (const file of walk(path.join(root, "src"))) {
      if (allowed.includes(file)) continue;
      expect(readFileSync(file, "utf8"), file).not.toContain("MAILBOX_ENC_KEY");
    }
  });
  test("every server file of the e-mail area imports server-only, and so do the AI e-mail tasks", () => {
    for (const file of [...SERVER_FILES, path.join(root, "src/lib/ai/email-tasks.ts"), path.join(root, "src/lib/ai/email-schemas.ts"), path.join(root, "src/lib/ai/prompts/email.ts")]) {
      expect(readFileSync(file, "utf8"), file).toMatch(/^import "server-only";/m);
    }
  });
  test("no client component imports the e-mail engine, crypto, transports, session or store", () => {
    for (const file of walk(path.join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!/^["']use client["'];?/m.test(text)) continue;
      expect(text, file).not.toMatch(/@\/lib\/email\/(config|crypto|transport|parse|engine|session|supabase-store)|nodemailer|imapflow|mailparser/);
    }
  });
  test("mail libraries are imported only by the transport and parser modules", () => {
    for (const file of walk(path.join(root, "src"))) {
      if ([email("transport.ts"), email("parse.ts")].includes(file)) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from "(nodemailer|imapflow|mailparser)"/);
    }
  });
  test("SSRF: only the fixed Gmail hosts and ports are used; no host comes from user input", () => {
    const text = readFileSync(email("transport.ts"), "utf8");
    expect(text).toMatch(/GMAIL_SMTP = \{ host: "smtp\.gmail\.com", port: 465, secure: true \}/);
    expect(text).toMatch(/GMAIL_IMAP = \{ host: "imap\.gmail\.com", port: 993, secure: true \}/);
    const hosts = [...text.matchAll(/\bhost: ([^,}\n]+)/g)].map((m) => m[1].trim()).sort();
    expect(hosts).toEqual(['"imap.gmail.com"', '"smtp.gmail.com"', "GMAIL_IMAP.host", "GMAIL_SMTP.host"]);
    for (const file of walk(path.join(root, "src"))) {
      if (file === email("transport.ts")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(/createTransport|new ImapFlow/);
    }
  });
  test("R10 the e-mail libraries never log (no console calls that could print a password or a body)", () => {
    for (const file of walk(path.join(root, "src/lib/email"))) expect(readFileSync(file, "utf8"), file).not.toMatch(/console\./);
    expect(readFileSync(email("crypto.ts"), "utf8")).toMatch(/aes-256-gcm/);
  });
  test("R13 R1 the AI e-mail tasks cannot send, approve, delete, suppress-remove or change limits; only a person approves", () => {
    for (const f of ["src/lib/ai/email-tasks.ts", "src/lib/ai/prompts/email.ts", "src/lib/ai/email-schemas.ts"]) {
      const text = readFileSync(path.join(root, f), "utf8");
      expect(text, f).not.toMatch(/set_email_approval|claim_next_email|finish_email_send|set_campaign_send_mode|daily_limit|\.delete\(|\.rpc\(|transport\.ts|SmtpTransport|ImapTransport|from\("/);
    }
    // the engine never approves: approval exists only as a user action (server action -> set_email_approval)
    const engine = readFileSync(email("engine.ts"), "utf8");
    expect(engine).not.toMatch(/set_email_approval|approve/i);
    const approvers = walk(path.join(root, "src")).filter((f) => readFileSync(f, "utf8").includes("set_email_approval"));
    expect(approvers.map((f) => path.relative(root, f))).toEqual(["src/app/(app)/campanhas/actions.ts"]);
  });
  test("R14 the public unsubscribe path uses only the anon key through the narrow RPC", () => {
    const route = readFileSync(path.join(root, "src/app/api/unsubscribe/[token]/route.ts"), "utf8");
    const lib = readFileSync(email("unsubscribe.ts"), "utf8");
    expect(lib).toMatch(/rpc\("unsubscribe_by_token"/);
    expect(lib).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(`${route}\n${lib}`).not.toMatch(/from\(["']/);
  });
});

describe("R11: the e-mail area has no SMS, WhatsApp or LinkedIn path", () => {
  test("no sms / whatsapp / twilio words in the e-mail code, screens or migration", () => {
    const files = [
      ...walk(path.join(root, "src/lib/email")),
      ...walk(path.join(root, "src/app/(app)/campanhas")),
      ...walk(path.join(root, "src/app/(app)/configuracoes")),
      ...walk(path.join(root, "src/app/(app)/leads")),
      ...walk(path.join(root, "src/components/email")),
      path.join(root, "src/lib/ai/email-tasks.ts"),
      path.join(root, "src/lib/ai/prompts/email.ts"),
      path.join(root, "supabase/migrations/0003_email.sql"),
    ];
    for (const file of files) expect(readFileSync(file, "utf8").toLowerCase(), file).not.toMatch(/\bsms\b|whatsapp|twilio|linkedin/);
  });
});

describe("E1 scheduler: anon key and scheduler_* functions only, no logging, no new env var", () => {
  const route = path.join(root, "src/app/api/scheduler/tick/route.ts");
  const store = path.join(root, "src/lib/email/scheduler-store.ts");
  const tick = path.join(root, "src/lib/email/scheduler.ts");

  test("the route, the store and the tick import server-only (the route is a server file by construction)", () => {
    for (const f of [store, tick]) expect(readFileSync(f, "utf8"), f).toMatch(/^import "server-only";/m);
  });
  test("the store uses only the public anon key through scheduler_* RPCs: no table access, no other function, no cookies", () => {
    const text = readFileSync(store, "utf8");
    expect(text).toMatch(/env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(text).not.toMatch(/\.from\(/);
    expect(text).not.toMatch(/process\.env|next\/headers|supabase\/server|@supabase\/ssr/);
    const rpcs = [...text.matchAll(/this\.rpc(?:<[^(]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs.length).toBeGreaterThan(0);
    for (const name of rpcs) expect(name, name).toMatch(/^scheduler_[a-z_]+$/);
    expect(new Set(rpcs)).toEqual(
      new Set(["scheduler_begin_run", "scheduler_due_work", "scheduler_finish_run", "scheduler_sender", "scheduler_campaign", "scheduler_prospect", "scheduler_message", "scheduler_claim_next_email", "scheduler_finish_email_send"]),
    );
    expect(text.match(/this\.db\.rpc\(/g)).toHaveLength(1); // the one generic helper; every call site names a scheduler_* function above
  });
  test("the route and the store never touch the mailbox secret, the transports or the AI", () => {
    for (const f of [route, store, tick]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/mailbox_secret|getMailboxKey|MAILBOX_ENC_KEY|decryptSecret|GmailSmtp|GmailImap|imapflow|nodemailer|@\/lib\/ai\/|supabase-store|emailSession/);
    }
  });
  test("R10 the clock never logs: no console in the route, the store or the tick", () => {
    for (const f of [route, store, tick]) expect(readFileSync(f, "utf8"), f).not.toMatch(/console\./);
  });
  test("the route checks the bearer shape before it creates a store, and exports the expected segment config", () => {
    const text = readFileSync(route, "utf8");
    expect(text).toMatch(/export const maxDuration = 60;/);
    expect(text).toMatch(/export const dynamic = "force-dynamic";/);
    expect(text.indexOf("BEARER.exec")).toBeGreaterThan(-1);
    expect(text.indexOf("BEARER.exec")).toBeLessThan(text.indexOf("createSchedulerStore("));
  });
  test("the clock is public to the proxy (no session) and nothing else new is", () => {
    const text = readFileSync(path.join(root, "src/lib/supabase/proxy.ts"), "utf8");
    expect(text).toMatch(/PUBLIC_PATHS = \["\/login", "\/u", "\/api\/unsubscribe", "\/api\/scheduler", "\/api\/hunter"\]/);
  });
  test("no new environment variable: the eight known names are the only ones named anywhere in src", () => {
    const known = new Set(["AI_GLOBAL_DAILY_CAP_USD", "AI_USER_DAILY_CAP_USD", "ANTHROPIC_API_KEY", "APP_PUBLIC_ORIGIN", "MAILBOX_ENC_KEY", "MAILBOX_ENC_KEY_PREVIOUS", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"]);
    for (const f of [route, store, tick, path.join(root, "src/lib/email/engine.ts")]) {
      const names = readFileSync(f, "utf8").match(/process\.env\.[A-Z0-9_]+|\benv\.[A-Z][A-Z0-9_]+/g) ?? [];
      for (const n of names) expect(known.has(n.replace(/^process\.env\.|^env\./, "")), `${f}: ${n}`).toBe(true);
    }
    expect(Object.keys(envSchema.shape)).toHaveLength(8);
  });
  test("the manual cron script lives outside migrations and carries placeholders, not a real token", () => {
    const text = readFileSync(path.join(root, "supabase/manual/scheduler_cron.sql"), "utf8");
    expect(text).toContain("<APP_URL>");
    expect(text).toContain("<TOKEN>");
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(readdirSync(path.join(root, "supabase/migrations")).some((f) => f.includes("cron"))).toBe(false);
  });
});

describe("F3d sources: keys stay on the server", () => {
  test("connections.ts is server-only, and no client component imports it, the clients, crypto or the RPC secret", () => {
    expect(readFileSync(path.join(root, "src/lib/sources/connections.ts"), "utf8")).toMatch(/^import "server-only";/m);
    for (const file of walk(path.join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!/^["']use client["'];?/m.test(text)) continue;
      expect(text.replace(/^import type .*$/gm, ""), file).not.toMatch(/@\/lib\/sources\/(connections|apify|apollo|http|maps)["']/);
    }
  });
  test("the screen never reads a stored key: no source_secret call, no secret_ciphertext, no .from() on connections", () => {
    for (const file of walk(path.join(root, "src/app/(app)/configuracoes/fontes")).concat(walk(path.join(root, "src/components/sources")), [path.join(root, "src/lib/sources/connections.ts")])) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/source_secret|secret_ciphertext|\.from\(|console\./);
    }
  });
  test("the client bundle check forbids api.apify.com and api.apollo.io", () => {
    const script = readFileSync(path.join(root, "scripts/check-client-bundle.mjs"), "utf8");
    expect(script).toContain("api\\.apify\\.com");
    expect(script).toContain("api\\.apollo\\.io");
  });
});
