import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

/** A rule is "real" when each named test file exists and mentions the rule id (in a test name or tag). */
export function covered(rule: string, ...files: string[]) {
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const p = path.join(root, f);
    expect(existsSync(p), f).toBe(true);
    expect(readFileSync(p, "utf8"), `${rule} in ${f}`).toMatch(new RegExp(`\\b${rule}\\b`));
  }
}
