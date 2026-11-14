import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("server-only", () => ({}));
const { isPublicAddress, nodeRawHttp } = await import("@/lib/qualifier/site/net");
const { parseRobots, robotsAllows } = await import("@/lib/qualifier/site/robots");
const { extractFromHtml } = await import("@/lib/qualifier/site/extract");
const { readSite, SITE_LIMITS, USER_AGENT } = await import("@/lib/qualifier/site/reader");
import type { RawHttp, RawResponse } from "@/lib/qualifier/site/net";

const html = (body: string, status = 200): RawResponse => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body: `<html><body>${body}</body></html>`, truncated: false });
const text = (body: string, status = 200): RawResponse => ({ status, headers: { "content-type": "text/plain" }, body, truncated: false });

/** Fake network keyed by URL; records every request and its options. */
function fakeHttp(routes: Record<string, RawResponse | Error>) {
  const calls: { url: string; at: number; ua: string; accept: string; maxBytes: number }[] = [];
  const clock = { t: 0 };
  const http: RawHttp = {
    async get(url, o) {
      calls.push({ url, at: clock.t, ua: o.userAgent, accept: o.accept, maxBytes: o.maxBytes });
      const r = routes[url] ?? (url.endsWith("/robots.txt") ? text("", 404) : html("nothing", 404));
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const deps = { http, sleep: async (ms: number) => void (clock.t += ms), now: () => clock.t, gaps: new Map<string, number>() };
  return { deps, calls, clock };
}

describe("isPublicAddress", () => {
  test("blocks private, loopback, link-local, CGNAT, multicast, documentation and mapped addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "100.64.0.1", "172.16.0.1", "192.168.1.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "224.0.0.1", "203.0.113.9", "2001:db8::1", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("nodeRawHttp", () => {
  test("refuses a loopback server before sending anything", async () => {
    let seen = 0;
    const server = http.createServer((_req, res) => {
      seen++;
      res.end("hi");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const o = { timeoutMs: 2000, maxBytes: 1000, userAgent: "t", accept: "*/*" };
    try {
      await expect(nodeRawHttp.get(`http://127.0.0.1:${port}/`, o)).rejects.toMatchObject({ code: "blocked_address" });
      await expect(nodeRawHttp.get(`http://localhost:${port}/`, o)).rejects.toMatchObject({ code: "blocked_address" });
      await expect(nodeRawHttp.get(`http://[::ffff:127.0.0.1]:${port}/`, o)).rejects.toMatchObject({ code: "blocked_address" });
      expect(seen).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("robots", () => {
  test("the KolmeiaBot group wins over *, longest match, allow on a tie, * and $ wildcards", () => {
    const txt = `User-agent: *\nDisallow: /\n\nUser-agent: kolmeiabot\nDisallow: /private\nAllow: /private/open\nDisallow: /tie\nAllow: /tie\nDisallow: /*.pdf$\n`;
    const r = parseRobots(txt, "KolmeiaBot");
    expect(robotsAllows(r, "/")).toBe(true);
    expect(robotsAllows(r, "/private/x")).toBe(false);
    expect(robotsAllows(r, "/private/open/x")).toBe(true);
    expect(robotsAllows(r, "/tie")).toBe(true);
    expect(robotsAllows(r, "/a/b.pdf")).toBe(false);
    expect(robotsAllows(r, "/a/b.pdf?x=1")).toBe(true);
    const star = parseRobots(txt.split("\n\n")[0], "KolmeiaBot");
    expect(robotsAllows(star, "/anything")).toBe(false);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow:\n", "KolmeiaBot"), "/x")).toBe(true);
  });
});

describe("extractFromHtml", () => {
  const page = "https://acme-heat.test/";
  test("reads JSON-LD (graph and arrays), tel:, mailto:, the address and the contact links", () => {
    const ld = JSON.stringify({
      "@graph": [
        { "@type": "WebSite", name: "ignored" },
        { "@type": ["LocalBusiness", "Thing"], name: "Acme Heat", telephone: "+1 508-555-0100", email: "info@acme-heat.test", address: { streetAddress: "1 Main St", addressLocality: "Worcester", addressRegion: "MA", postalCode: "01608" } },
      ],
    });
    const arr = JSON.stringify([{ "@type": "HVACBusiness", name: "Other", telephone: "508 555 0111" }]);
    const doc = `<head><script type="application/ld+json">${ld}</script><script type="application/ld+json">{bad json</script><script type="application/ld+json">${arr}</script></head>
      <a href="tel:+1-508-555-0122">Call</a> <a href="mailto:sales@acme-heat.test?subject=Hi">Mail</a>
      <a href="/contact-us#top">Contact</a> <a href="https://acme-heat.test/about">About us</a> <a href="https://other.test/contact">Elsewhere</a>
      <a href="/services">Services</a> <a href="/team">T</a> <a href="/company">C</a> <a href="/sobre">S</a>`;
    const f = extractFromHtml(doc, page);
    expect(f.name).toBe("Acme Heat");
    expect(f.phones.map((p) => p.value)).toEqual(["+1 508-555-0100", "508 555 0111", "+1-508-555-0122"]);
    expect(f.emails.map((e) => e.value)).toEqual(["info@acme-heat.test", "sales@acme-heat.test"]);
    expect(f.emails[0].url).toBe(page);
    expect(f.address?.value).toBe("1 Main St");
    expect([f.city?.value, f.state?.value, f.zip?.value]).toEqual(["Worcester", "MA", "01608"]);
    expect(f.links).toEqual(["https://acme-heat.test/contact-us", "https://acme-heat.test/about", "https://acme-heat.test/team"]);
  });
  test("ignores e-mails in scripts, image names and placeholder domains, and takes no phone from loose digits", () => {
    const doc = `<script>var m = "dev@secret-tool.test";</script><style>.a{}</style>
      <img src="logo@2x.png"> logo@2x.png you@example.com me@sample.example.org
      Write to real@acme-heat.test or call 508 555 0100 today. Zip 01608 1234567890`;
    const f = extractFromHtml(doc, page);
    expect(f.emails.map((e) => e.value)).toEqual(["real@acme-heat.test"]);
    expect(f.phones).toEqual([]);
    expect(f.text).not.toContain("secret-tool");
    expect(f.text.length).toBeLessThanOrEqual(20_000);
    expect(extractFromHtml(`<p>${"a ".repeat(30_000)}&amp; &#65;</p>`, page).text.length).toBe(20_000);
    expect(extractFromHtml("<p>Tom &amp; Jerry &#65;</p>", page).text).toBe("Tom & Jerry A");
  });
});

describe("readSite", () => {
  const HOME = "https://acme-heat.test/";
  const homeHtml = `<a href="/contact">Contact</a><a href="/about">About</a><a href="/team">Team</a><a href="/company">Company</a> Welcome`;

  test("reads the home and up to 3 contact pages, one request per second per host, with the UA", async () => {
    const f = fakeHttp({ [HOME]: html(homeHtml), "https://acme-heat.test/contact": html("Contact page"), "https://acme-heat.test/about": html("About page"), "https://acme-heat.test/team": html("Team page"), "https://acme-heat.test/company": html("never") });
    const r = await readSite("https://acme-heat.test", f.deps);
    expect(r.outcome).toBe("ok");
    expect(r.finalHome).toBe(HOME);
    expect(r.pages.map((p) => p.url)).toEqual([HOME, "https://acme-heat.test/contact", "https://acme-heat.test/about", "https://acme-heat.test/team"]);
    expect(r.pages).toHaveLength(SITE_LIMITS.maxPages);
    expect(f.calls.every((c) => c.ua === USER_AGENT)).toBe(true);
    expect(f.calls[0].url).toBe("https://acme-heat.test/robots.txt");
    expect(f.calls[0].accept).toBe("text/plain");
    expect(f.calls.some((c) => c.url.endsWith("/company"))).toBe(false);
    for (let i = 1; i < f.calls.length; i++) expect(f.calls[i].at - f.calls[i - 1].at).toBeGreaterThanOrEqual(1000);
    expect(f.calls.every((c) => c.maxBytes === 1_000_000)).toBe(true);
  });

  test("403/429/captcha -> site_blocked, 404 home -> site_down, a PDF -> not_html, robots disallow -> robots and nothing else is fetched; a robots 5xx reads nothing", async () => {
    for (const status of [403, 429]) expect((await readSite(HOME, fakeHttp({ [HOME]: html("no", status) }).deps)).outcome).toBe("site_blocked");
    expect((await readSite(HOME, fakeHttp({ [HOME]: html("<title>Attention Required! | Cloudflare</title>") }).deps)).outcome).toBe("site_blocked");
    expect((await readSite(HOME, fakeHttp({ [HOME]: html("Please solve this captcha") }).deps)).outcome).toBe("site_blocked");
    expect((await readSite(HOME, fakeHttp({ [HOME]: html("x", 404) }).deps)).outcome).toBe("site_down");
    expect((await readSite(HOME, fakeHttp({ [HOME]: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }).deps)).outcome).toBe("site_down");
    expect((await readSite(HOME, fakeHttp({ [HOME]: { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF", truncated: false } }).deps)).outcome).toBe("not_html");
    expect((await readSite("", fakeHttp({}).deps)).outcome).toBe("no_site");
    expect((await readSite("http://10.0.0.5/", fakeHttp({}).deps)).outcome).toBe("no_site");

    const dis = fakeHttp({ "https://acme-heat.test/robots.txt": text("User-agent: *\nDisallow: /\n"), [HOME]: html("hi") });
    const r = await readSite(HOME, dis.deps);
    expect(r).toEqual({ outcome: "robots", pages: [], finalHome: null });
    expect(dis.calls.map((c) => c.url)).toEqual(["https://acme-heat.test/robots.txt"]);

    const five = fakeHttp({ "https://acme-heat.test/robots.txt": text("oops", 503), [HOME]: html("hi") });
    expect((await readSite(HOME, five.deps)).outcome).toBe("robots");
    expect(five.calls).toHaveLength(1);
  });

  test("each redirect is re-checked; to a private address, another port or a blocked host it stops; a 4th redirect is error", async () => {
    const redir = (to: string): RawResponse => ({ status: 301, headers: { location: to }, body: "", truncated: false });
    const bad = ["http://169.254.169.254/latest", "http://[::ffff:127.0.0.1]/", "https://acme-heat.test:8443/", "http://localhost/admin", "https://www.linkedin.com/company/acme", "ftp://acme-heat.test/"];
    for (const to of bad) {
      const f = fakeHttp({ [HOME]: redir(to) });
      expect((await readSite(HOME, f.deps)).outcome, to).toBe("error");
      expect(f.calls.map((c) => c.url), to).toEqual(["https://acme-heat.test/robots.txt", HOME]);
    }
    // a DNS answer that is private on a later hop surfaces as a refusal from the socket layer
    const priv = fakeHttp({ [HOME]: redir("https://moved.test/"), "https://moved.test/": Object.assign(new Error("b"), { code: "blocked_address" }) });
    expect((await readSite(HOME, priv.deps)).outcome).toBe("error");

    const ok = fakeHttp({ [HOME]: redir("https://www.acme-heat.test/"), "https://www.acme-heat.test/": redir("https://acme-heat.test/home"), "https://acme-heat.test/home": html("Landed") });
    const done = await readSite(HOME, ok.deps);
    expect(done.outcome).toBe("ok");
    expect(done.finalHome).toBe("https://acme-heat.test/home");
    expect(ok.calls.filter((c) => c.url.endsWith("/robots.txt")).map((c) => c.url)).toEqual(["https://acme-heat.test/robots.txt", "https://www.acme-heat.test/robots.txt"]);

    const loop = fakeHttp({ [HOME]: redir("https://a.test/"), "https://a.test/": redir("https://b.test/"), "https://b.test/": redir("https://c.test/"), "https://c.test/": redir("https://d.test/"), "https://d.test/": html("too far") });
    expect((await readSite(HOME, loop.deps)).outcome).toBe("error");
    const three = fakeHttp({ [HOME]: redir("https://a.test/"), "https://a.test/": redir("https://b.test/"), "https://b.test/": redir("https://c.test/"), "https://c.test/": html("exactly 3 hops") });
    expect((await readSite(HOME, three.deps)).outcome).toBe("ok");
  });

  test("a body over 1 MB is cut and only the first MB is parsed", async () => {
    // the loopback guard refuses a real socket, so the cut is checked through a fake with the same contract (maxBytes is asserted above)
    const big: RawResponse = { status: 200, headers: { "content-type": "text/html" }, body: `<p>start</p>${"x".repeat(999_900)}`, truncated: true };
    const r = await readSite(HOME, fakeHttp({ [HOME]: big }).deps);
    expect(r.outcome).toBe("ok");
    expect(r.pages[0].text.startsWith("start")).toBe(true);
    expect(r.pages[0].text.length).toBeLessThanOrEqual(20_000);
    expect(r.pages[0].facts.emails).toEqual([]);
  });
});
