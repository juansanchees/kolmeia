import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { assertOutsideRepo, filterCsv, pilotDataDir, pilotOutDir, pilotUrl, PROD_REF, DEV_REF } from "../../scripts/pilot-env";

const root = path.resolve(import.meta.dirname, "../..");
const repo = path.resolve(root, "..");

describe("pilot env guards", () => {
  test("the prod ref is always refused, even with the dev flag", () => {
    expect(() => pilotUrl({ PILOT_SUPABASE_URL: `https://${PROD_REF}.supabase.co` })).toThrow(/production/);
    expect(() => pilotUrl({ PILOT_SUPABASE_URL: `https://${PROD_REF}.supabase.co`, PILOT_ALLOW_DEV: "1" })).toThrow(/production/);
  });
  test("local by default; the dev ref only with PILOT_ALLOW_DEV=1; any other host refused", () => {
    expect(pilotUrl({})).toBe("http://127.0.0.1:54321");
    expect(pilotUrl({ PILOT_SUPABASE_URL: "http://localhost:54321" })).toBe("http://localhost:54321");
    expect(() => pilotUrl({ PILOT_SUPABASE_URL: `https://${DEV_REF}.supabase.co` })).toThrow();
    expect(pilotUrl({ PILOT_SUPABASE_URL: `https://${DEV_REF}.supabase.co`, PILOT_ALLOW_DEV: "1" })).toContain(DEV_REF);
    expect(() => pilotUrl({ PILOT_SUPABASE_URL: "https://example.com" })).toThrow();
    expect(() => pilotUrl({ PILOT_SUPABASE_URL: "http://127.0.0.1.example.com" })).toThrow();
    // the dev ref only counts as the hostname: in a path, query, userinfo or another host it never qualifies
    for (const u of [`https://example.com/${DEV_REF}`, `https://example.com/?r=${DEV_REF}`, `https://${DEV_REF}.supabase.co.evil.example`, `https://${DEV_REF}@evil.example`, `http://${DEV_REF}.supabase.co`])
      expect(() => pilotUrl({ PILOT_SUPABASE_URL: u, PILOT_ALLOW_DEV: "1" }), u).toThrow();
    expect(() => pilotUrl({ PILOT_SUPABASE_URL: "http://[::1]:54321" })).toThrow();
  });
  test("data and out dirs inside the repo are refused", () => {
    expect(() => pilotDataDir({ PILOT_DATA_DIR: path.join(repo, "data") })).toThrow(/outside kolmeia/);
    expect(() => pilotOutDir({ PILOT_OUT_DIR: path.join(root, "out") })).toThrow(/outside kolmeia/);
    expect(() => assertOutsideRepo(repo, "X")).toThrow();
    expect(assertOutsideRepo(path.join(os.tmpdir(), "x"), "X")).toContain("x");
  });
  test("filterCsv keeps the header and the accepted rows, quoting commas", () => {
    const out = filterCsv('name,city\n"Acme, Inc",Falmouth\nBay,Boston\n', (r) => r.city === "Falmouth");
    expect(out).toBe('name,city\n"Acme, Inc",Falmouth\n');
  });
});

describe("pilot scripts", () => {
  const files = readdirSync(path.join(root, "scripts")).filter((f) => /^(pilot-.*|eval-falmouth)\.smoke\.ts$/.test(f));
  test("the three scripts exist and each is skipped without its flag", () => {
    expect(files.sort()).toEqual(["eval-falmouth.smoke.ts", "pilot-falmouth.smoke.ts", "pilot-seed-local.smoke.ts"]);
    const flags: Record<string, string> = { "eval-falmouth.smoke.ts": "EVAL_RUN", "pilot-falmouth.smoke.ts": "PILOT_RUN", "pilot-seed-local.smoke.ts": "PILOT_SEED" };
    for (const f of files) expect(readFileSync(path.join(root, "scripts", f), "utf8"), f).toContain(`test.skipIf(process.env.${flags[f]} !== "1")`);
  });
  test("no key literal in the pilot scripts, and the round runner never reads the gold folder", () => {
    for (const f of [...files, "pilot-env.ts"]) expect(readFileSync(path.join(root, "scripts", f), "utf8"), f).not.toMatch(/sb_secret_|eyJ[A-Za-z0-9_-]{10,}\./);
    expect(readFileSync(path.join(root, "scripts/pilot-falmouth.smoke.ts"), "utf8")).not.toMatch(/falmouth_gold|gold\//i);
  });
});
