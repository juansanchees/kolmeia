import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("server-only", () => ({}));
const { isPublicAddress, nodeRawHttp, createRawHttpForTest } = await import("@/lib/qualifier/site/net");
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
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "100.64.0.1", "172.16.0.1", "192.168.1.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "224.0.0.1", "203.0.113.9", "2001:db8::1", "not-an-ip", "::7f00:1", "::ffff:0:7f00:1", "::ffff:0:8.8.8.8", "fec0::1", "2002:7f00:1::", "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1"]) {
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
      const real = createRawHttpForTest({ allowPort: () => true }); // real address guard, any port
      await expect(real.get(`http://127.0.0.1:${port}/`, o)).rejects.toMatchObject({ code: "blocked_address" });
      await expect(real.get(`http://localhost:${port}/`, o)).rejects.toMatchObject({ code: "blocked_address" });
      await expect(real.get(`http://[::ffff:127.0.0.1]:${port}/`, o)).rejects.toMatchObject({ code: "blocked_address" });
      expect(seen).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("nodeRawHttp guards and limits", () => {
  const o = { timeoutMs: 2000, maxBytes: 1000, userAgent: "t", accept: "*/*" };
  test("refuses other ports, credentials, blocked hosts and non-http schemes without connecting", async () => {
    for (const u of ["http://8.8.8.8:8080/", "https://user:pw@8.8.8.8/", "https://www.linkedin.com/x", "ftp://8.8.8.8/"]) {
      await expect(nodeRawHttp.get(u, o), u).rejects.toMatchObject({ code: "bad_url" });
    }
  });
  async function serve(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const client = createRawHttpForTest({ isPublic: () => true, allowPort: () => true });
    return { url, client, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  }
  test("a body over maxBytes is cut at exactly maxBytes and flagged truncated", async () => {
    const s = await serve((_q, res) => {
      res.setHeader("content-type", "text/html");
      res.end("a".repeat(5000));
    });
    try {
      const r = await s.client.get(s.url, { ...o, maxBytes: 1000 });
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.body)).toBe(1000);
      const small = await s.client.get(s.url, { ...o, maxBytes: 10_000 });
      expect(small.truncated).toBe(false);
      expect(small.body.length).toBe(5000);
    } finally {
      await s.close();
    }
  });
  test("a connection that closes before the body is complete counts as truncated", async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": "5000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 20);
    });
    try {
      const r = await s.client.get(s.url, o).catch((e) => ({ err: e }));
      if ("err" in r) expect(r.err).toBeTruthy(); // a reset may also surface as an error: both are "not complete"
      else expect(r.truncated).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("robots", () => {
  test("agent token must equal ours: 'bot' does not apply, 'KolmeiaBot/1.0' does", () => {
    expect(robotsAllows(parseRobots("User-agent: bot\nDisallow: /\n", "KolmeiaBot/1.0"), "/x")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: Kolmeia\nDisallow: /\n", "KolmeiaBot"), "/x")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: KolmeiaBot/1.0\nDisallow: /\n", "KolmeiaBot"), "/x")).toBe(false);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /a\nUser-agent: bot\nDisallow: /\n", "KolmeiaBot"), "/b")).toBe(true);
  });
  test("a Disallow rule over 500 chars shuts its whole group; a long Allow is ignored", () => {
    const long = "x".repeat(600);
    expect(robotsAllows(parseRobots(`User-agent: *\nDisallow: /a\nDisallow: /${long}\n`, "KolmeiaBot"), "/anything")).toBe(false);
    expect(robotsAllows(parseRobots(`User-agent: KolmeiaBot\nDisallow: /${long}\nUser-agent: other\nDisallow: /z\n`, "KolmeiaBot"), "/ok")).toBe(false);
    expect(robotsAllows(parseRobots(`User-agent: *\nDisallow: /a\nAllow: /${long}\n`, "KolmeiaBot"), "/b")).toBe(true);
    // the other group keeps its own rules
    expect(robotsAllows(parseRobots(`User-agent: bot\nDisallow: /${long}\nUser-agent: *\nDisallow: /a\n`, "KolmeiaBot"), "/b")).toBe(true);
  });
  test("hostile wildcard rules finish fast (no exponential backtracking)", () => {
    const evil = `${"*a".repeat(240)}*b`;
    const r = parseRobots(`User-agent: *\n${Array.from({ length: 600 }, () => `Disallow: ${evil}`).join("\n")}\n`, "KolmeiaBot");
    expect(r.disallow.length).toBeLessThanOrEqual(500);
    const t = performance.now();
    expect(robotsAllows(r, `/${"a".repeat(2000)}`)).toBe(true);
    expect(performance.now() - t).toBeLessThan(200);
    expect(robotsAllows({ allow: [], disallow: ["/*a*a*$"] }, "/xaxa")).toBe(false);
    expect(robotsAllows({ allow: [], disallow: ["/*a*a*$"] }, "/xaxab")).toBe(false);
    expect(robotsAllows({ allow: [], disallow: ["/*a$"] }, "/xaxab")).toBe(true);
  });

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

describe("extractFromHtml: visible-text phones, caps and flags", () => {
  const pg = "https://acme-heat.test/";
  test("a footer phone in plain text is found like a tel: phone; zip and year digits are not", () => {
    const f = extractFromHtml(`<footer><p>Acme Heating, 12 Main St, Worcester MA 01608 since 1998. Call (508) 555-0143 today</p><p>Fax 508.555.0188</p></footer><a href="tel:+1-508-555-0143">x</a>`, pg);
    expect(f.phones.map((p) => p.value)).toEqual(["+1-508-555-0143", "508.555.0188"]);
    expect(f.phones[1].excerpt).toContain("Fax");
    const g = extractFromHtml(`<p>Zip 01608 5085550143 and 20245085550143 and 15085550101</p>`, pg);
    expect(g.phones.map((p) => p.value.replace(/\D/g, ""))).toEqual(["5085550143", "15085550101"]);
  });
  test("at most 10 text phones per page", () => {
    const many = Array.from({ length: 30 }, (_, i) => `508-555-${String(1000 + i)}`).join(" , ");
    expect(extractFromHtml(`<p>${many}</p>`, pg).phones).toHaveLength(10);
  });
  test("a 1 MB flood of digits and separators is scanned in linear time", () => {
    for (const flood of ["1".repeat(1_000_000), "5085550143".repeat(100_000), "1 ".repeat(500_000), "(508) ".repeat(160_000), "1-".repeat(500_000)]) {
      const t = performance.now();
      const f = extractFromHtml(`<p>${flood}</p>`, pg);
      expect(performance.now() - t).toBeLessThan(2000);
      expect(f.phones.length).toBeLessThanOrEqual(10);
    }
  });
  test("deep nesting sets depthCapped; the content already read is kept", () => {
    const f = extractFromHtml(`<p>Call 508-555-0143</p>${"<div>".repeat(60_000)}tail`, pg);
    expect(f.depthCapped).toBe(true);
    expect(f.phones).toHaveLength(1);
    expect(extractFromHtml("<div><p>ok</p></div>", pg).depthCapped).toBeUndefined();
  });
  test("the 200 e-mail limit counts accepted candidates only", () => {
    const junk = "@@ x@y ".repeat(300);
    const good = Array.from({ length: 5 }, (_, i) => `u${i}@acme-heat.test`).join(" ");
    expect(extractFromHtml(`<p>${junk} ${good}</p>`, pg).emails).toHaveLength(5);
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
  test("a ~1 MB hostile page (unclosed anchors, meta, scripts, long runs) is parsed in under 200 ms", () => {
    const cases = [`<a href="x">`.repeat(80_000), `<meta property="og:site_name" content="`.repeat(25_000), `<script type="application/ld+json">`.repeat(30_000), "a".repeat(1_000_000), `<a href="mailto:${"a".repeat(100)}">`.repeat(9_000), "@".repeat(500_000), `${"a@".repeat(250_000)}`, "<".repeat(900_000)];
    for (const c of cases) {
      const t = performance.now();
      const f = extractFromHtml(c, page);
      expect(performance.now() - t, c.slice(0, 30)).toBeLessThan(200);
      expect(f.text.length).toBeLessThanOrEqual(20_000);
      expect(f.links.length).toBeLessThanOrEqual(3);
    }
  });
  test("JSON-LD values are capped at 300 characters", () => {
    const ld = JSON.stringify({ "@type": "LocalBusiness", name: "N".repeat(900), address: { streetAddress: "S".repeat(900) } });
    const f = extractFromHtml(`<script type="application/ld+json">${ld}</script>`, page);
    expect(f.name?.length).toBe(300);
    expect(f.address?.value.length).toBe(300);
    expect(f.address!.excerpt.length).toBeLessThanOrEqual(300);
  });
  test("ignores e-mails in scripts, image names and placeholder domains, and takes a phone from the text only with a NANP shape", () => {
    const doc = `<script>var m = "dev@secret-tool.test";</script><style>.a{}</style>
      <img src="logo@2x.png"> logo@2x.png you@example.com me@sample.example.org
      Write to real@acme-heat.test or call 508 555 0100 today. Zip 01608 1234567890`;
    const f = extractFromHtml(doc, page);
    expect(f.emails.map((e) => e.value)).toEqual(["real@acme-heat.test"]);
    expect(f.phones.map((p) => p.value)).toEqual(["508 555 0100"]); // written in the text: found; "1234567890" and the zip are not
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
    const blockedErr = () => Object.assign(new Error("b"), { code: "blocked_address" });
    const priv = fakeHttp({ [HOME]: redir("https://moved.test/"), "https://moved.test/robots.txt": blockedErr() });
    expect((await readSite(HOME, priv.deps)).outcome).toBe("error");
    expect(priv.calls.map((c) => c.url)).toEqual(["https://acme-heat.test/robots.txt", HOME, "https://moved.test/robots.txt"]); // robots first, body never asked
    expect((await readSite(HOME, fakeHttp({ "https://acme-heat.test/robots.txt": blockedErr() }).deps)).outcome).toBe("site_down");

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

  test("an https to http redirect is refused (error) before the plain-http page is asked for", async () => {
    const f = fakeHttp({ [HOME]: { status: 301, headers: { location: "http://acme-heat.test/" }, body: "", truncated: false }, "http://acme-heat.test/": html("plain") });
    expect((await readSite(HOME, f.deps)).outcome).toBe("error");
    expect(f.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
  });

  test("a subpage that redirects off the home host is refused before it is fetched", async () => {
    const f = fakeHttp({ [HOME]: html(homeHtml), "https://acme-heat.test/contact": { status: 302, headers: { location: "https://evil.test/x" }, body: "", truncated: false } });
    const r = await readSite(HOME, f.deps);
    expect(r.outcome).toBe("ok");
    expect(f.calls.some((c) => c.url.includes("evil.test"))).toBe(false);
  });

  test("the whole read stops at the 30 s deadline and returns what it has", async () => {
    const f = fakeHttp({ [HOME]: html(homeHtml), "https://acme-heat.test/contact": html("Contact"), "https://acme-heat.test/about": html("About") });
    const slow: RawHttp = { get: async (u, o) => { f.clock.t += 20_000; return f.deps.http.get(u, o); } };
    const r = await readSite(HOME, { ...f.deps, http: slow });
    expect(r.outcome).toBe("ok");
    expect(r.pages.map((p) => p.url)).toEqual([HOME]);
    const g = fakeHttp({ [HOME]: html("x") });
    const veryslow: RawHttp = { get: async () => { g.clock.t += 31_000; return html("x"); } };
    expect((await readSite(HOME, { ...g.deps, http: veryslow })).outcome).toBe("error");
  });

  test("a body over 1 MB is cut and only the first MB is parsed", async () => {
    const big: RawResponse = { status: 200, headers: { "content-type": "text/html" }, body: `<p>start</p>${"x".repeat(999_900)}`, truncated: true };
    const r = await readSite(HOME, fakeHttp({ [HOME]: big }).deps);
    expect(r.outcome).toBe("ok");
    expect(r.pages[0].text.startsWith("start")).toBe(true);
    expect(r.pages[0].text.length).toBeLessThanOrEqual(20_000);
    expect(r.pages[0].facts.emails).toEqual([]);
  });
});
