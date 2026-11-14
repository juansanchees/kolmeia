import { hostOf } from "@/lib/safe-url";

// Facts read from one HTML page. Pure; regex based on purpose (no DOM in the node runtime). Only what is written on
// the page is returned (R18): e-mails are never guessed and a phone never comes from loose digits.

export type Found = { value: string; url: string; excerpt: string };
export type SiteFacts = {
  name: string | null;
  phones: Found[];
  emails: Found[];
  address: Found | null;
  city: Found | null;
  state: Found | null;
  zip: Found | null;
  links: string[];
  text: string;
};

const MAX_TEXT = 20_000;
const MAX_EXCERPT = 300;
const CONTACT_LINK = /contact|about|contato|sobre|team|company|empresa/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp|tiff?)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: "..." };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);

function visibleText(html: string): string {
  const t = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decode(t).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

function emailOk(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || IMAGE_EXT.test(email)) return false;
  return !/(^|\.)example\.[a-z.]+$/.test(domain) && domain !== "example";
}

function isBusinessType(t: unknown): boolean {
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => typeof x === "string" && (x === "Organization" || /(Business|Contractor)$/.test(x)));
}

function* jsonLdNodes(v: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(v)) {
    for (const x of v) yield* jsonLdNodes(x);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    yield o;
    if (o["@graph"]) yield* jsonLdNodes(o["@graph"]);
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

export function extractFromHtml(html: string, pageUrl: string): SiteFacts {
  const facts: SiteFacts = { name: null, phones: [], emails: [], address: null, city: null, state: null, zip: null, links: [], text: "" };
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();
  const addPhone = (value: string, excerpt: string) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15 || seenPhones.has(digits)) return;
    seenPhones.add(digits);
    facts.phones.push({ value: value.trim(), url: pageUrl, excerpt: clip(excerpt) });
  };
  const addEmail = (value: string, excerpt: string) => {
    const e = value.trim().toLowerCase();
    if (!emailOk(e) || seenEmails.has(e)) return;
    seenEmails.add(e);
    facts.emails.push({ value: e, url: pageUrl, excerpt: clip(excerpt) });
  };
  const found = (value: string | null, label: string): Found | null => (value ? { value, url: pageUrl, excerpt: clip(`${label}: ${value}`) } : null);

  // JSON-LD
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    for (const node of jsonLdNodes(data)) {
      if (!isBusinessType(node["@type"])) continue;
      facts.name ??= str(node.name);
      const tel = str(node.telephone);
      if (tel) addPhone(tel, `telephone: ${tel}`);
      const mail = str(node.email);
      if (mail) addEmail(mail.replace(/^mailto:/i, ""), `email: ${mail}`);
      const a = Array.isArray(node.address) ? node.address[0] : node.address;
      if (typeof a === "string") facts.address ??= found(str(a), "address");
      else if (a && typeof a === "object") {
        const o = a as Record<string, unknown>;
        facts.address ??= found(str(o.streetAddress), "streetAddress");
        facts.city ??= found(str(o.addressLocality), "addressLocality");
        facts.state ??= found(str(o.addressRegion), "addressRegion");
        facts.zip ??= found(str(o.postalCode), "postalCode");
      }
    }
  }
  if (!facts.name) {
    const og = /<meta\b[^>]*property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html);
    facts.name = og ? decode(og[1]).trim() || null : null;
  }

  // tel: and mailto: links
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = decode(m[2]).trim();
    const label = visibleText(m[3]);
    if (/^tel:/i.test(href)) {
      let v = href.slice(4);
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      addPhone(v, `${href} ${label}`);
    } else if (/^mailto:/i.test(href)) {
      let v = href.slice(7).split("?")[0];
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      for (const one of v.split(",")) if (one.includes("@")) addEmail(one, `${href} ${label}`);
    }
  }

  facts.text = visibleText(html);

  // e-mails written in the visible text
  for (const m of facts.text.matchAll(EMAIL_RE)) {
    const at = m.index ?? 0;
    addEmail(m[0], facts.text.slice(Math.max(0, at - 60), at + m[0].length + 60));
  }

  // same-host contact / about links
  const pageHost = hostOf(pageUrl);
  const seenLinks = new Set<string>([pageUrl.replace(/#.*$/, "")]);
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    if (facts.links.length >= 3) break;
    const href = decode(m[2]).trim();
    if (!href || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if ((abs.protocol !== "http:" && abs.protocol !== "https:") || hostOf(abs.toString()) !== pageHost) continue;
    abs.hash = "";
    if (!CONTACT_LINK.test(abs.pathname) && !CONTACT_LINK.test(visibleText(m[3]))) continue;
    const out = abs.toString();
    if (seenLinks.has(out)) continue;
    seenLinks.add(out);
    facts.links.push(out);
  }
  return facts;
}
