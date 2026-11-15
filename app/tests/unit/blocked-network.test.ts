import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BLOCKED_NETWORK_HOSTS, BLOCKED_NETWORK_PROMPT, BLOCKED_NETWORK_RE } from "@/lib/blocked-network";
import { sanitizeUrl } from "@/lib/safe-url";

const D = ["linked", "in"].join("") + ".com";
const S = "lnkd.in";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules") return [];
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
}

describe("blocked professional network", () => {
  test.each([
    `https://www.${D}/in/x`, `http://${D}`, `https://br.${D}/company/y`, `HTTPS://WWW.${D.toUpperCase()}/IN/X`,
    `https://${S}/abc`, `https://${S.toUpperCase()}/abc`, `https://${D}./x`,
  ])("blocks %s", (u) => {
    expect(sanitizeUrl(u)).toBeNull();
  });
  test("normal site passes, look-alike host is not a subdomain", () => {
    expect(sanitizeUrl("https://example.com")).not.toBeNull();
    expect(sanitizeUrl(`https://${D}.evil.example/x`)).not.toBeNull();
  });
  test("hosts, regex and prompt cover the domain and the short link", () => {
    expect(BLOCKED_NETWORK_HOSTS).toEqual([D, S]);
    for (const t of ["Linked In", "linked_in", "LINKED-IN", S]) expect(BLOCKED_NETWORK_RE.test(t)).toBe(true);
    expect(BLOCKED_NETWORK_RE.test("example")).toBe(false);
    expect(BLOCKED_NETWORK_PROMPT).toContain(D);
    expect(BLOCKED_NETWORK_PROMPT).toContain(S);
  });
  test("the name is not a literal anywhere in src", () => {
    const root = path.resolve(__dirname, "../../src");
    const word = ["linked", "in"].join("");
    for (const f of walk(root)) expect(readFileSync(f, "utf8").toLowerCase(), f).not.toContain(word);
  });
});
