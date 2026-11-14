import { Parser } from "htmlparser2";
import { NANP } from "@/lib/nanp";
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
  /** The parser stopped early (tag nesting passed the cap): what follows the cut was not read. */
  depthCapped?: boolean;
};

const MAX_TEXT = 20_000;
const MAX_EXCERPT = 300;
const MAX_VALUE = 300;
const MAX_INPUT = 1_000_000;
const MAX_RAW_TEXT = 200_000;
const MAX_ANCHORS = 500;
const MAX_DEPTH = 2000; // unclosed-tag floods: the parser keeps an open-tag stack, so stop feeding when it grows
const CHUNK = 16_384;
const MAX_JSONLD = 20;
const MAX_JSONLD_CHARS = 200_000;
const MAX_EMAIL_CANDIDATES = 200;
const MAX_TEXT_PHONES = 10;
const MAX_EMAIL_SCAN = 5000;
const CONTACT_LINK = /contact|about|contato|sobre|team|company|empresa/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp|tiff?)$/i;
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);

/** At most n UTF-16 units, never ending in half a surrogate pair (a cut emoji would be an invalid character). */
export function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const r = s.slice(0, n);
  const c = r.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? r.slice(0, -1) : r;
}
const clip = (s: string) => cut(s.replace(/\s+/g, " ").trim(), MAX_EXCERPT);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function emailOk(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || IMAGE_EXT.test(email)) return false;
  return !/(^|\.)example\.[a-z.]+$/.test(domain) && domain !== "example";
}

/** E-mail candidates around each "@": one linear pass, no backtracking regex. */
function* emailsIn(text: string): Generator<{ email: string; at: number }> {
  const left = /[A-Za-z0-9._%+-]/;
  const right = /[A-Za-z0-9.-]/;
  let accepted = 0;
  let scanned = 0; // a flood of rejected "@" is bounded too: the scan is linear either way
  for (let i = text.indexOf("@"); i >= 0 && accepted < MAX_EMAIL_CANDIDATES && scanned < MAX_EMAIL_SCAN; i = text.indexOf("@", i + 1), scanned++) {
    let l = i;
    while (l > 0 && i - l < 64 && left.test(text[l - 1])) l--;
    let r = i + 1;
    while (r < text.length && r - i < 256 && right.test(text[r])) r++;
    const local = text.slice(l, i);
    const domain = text.slice(i + 1, r).replace(/^[.-]+|[.-]+$/g, "");
    if (!local || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(domain)) continue;
    accepted++;
    yield { email: `${local}@${domain}`, at: l };
  }
}

function isBusinessType(t: unknown): boolean {
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => typeof x === "string" && (x === "Organization" || /(Business|Contractor)$/.test(x)));
}

function* jsonLdNodes(v: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6) return;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 50)) yield* jsonLdNodes(x, depth + 1);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    yield o;
    if (o["@graph"]) yield* jsonLdNodes(o["@graph"], depth + 1);
  }
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s ? cut(s, MAX_VALUE) : null;
};

export function extractFromHtml(html: string, pageUrl: string): SiteFacts {
  const facts: SiteFacts = { name: null, phones: [], emails: [], address: null, city: null, state: null, zip: null, links: [], text: "" };
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();
  const addPhone = (value: string, excerpt: string) => {
    const v = cut(value.trim(), MAX_VALUE);
    const digits = v.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); // +1 and no +1 are one number
    if (digits.length < 7 || digits.length > 15 || seenPhones.has(digits)) return;
    seenPhones.add(digits);
    facts.phones.push({ value: v, url: pageUrl, excerpt: clip(excerpt) });
  };
  const addEmail = (value: string, excerpt: string) => {
    const e = cut(value.trim().toLowerCase(), MAX_VALUE);
    if (!emailOk(e) || seenEmails.has(e)) return;
    seenEmails.add(e);
    facts.emails.push({ value: e, url: pageUrl, excerpt: clip(excerpt) });
  };
  const found = (value: string | null, label: string): Found | null => (value ? { value, url: pageUrl, excerpt: clip(`${label}: ${value}`) } : null);

  const ldBlocks: string[] = [];
  const anchors: { href: string; label: string }[] = [];
  const pieces: string[] = [];
  let rawLen = 0;
  let skip = 0;
  let ld: string | null = null;
  let anchor: { href: string; label: string } | null = null;
  let ogName: string | null = null;
  let depth = 0;

  const closeAnchor = () => {
    if (anchor && anchors.length < MAX_ANCHORS) anchors.push(anchor);
    anchor = null;
  };
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        depth++;
        if (name === "script" && ldBlocks.length < MAX_JSONLD && /application\/ld\+json/i.test(attribs.type ?? "")) ld = "";
        if (SKIP_TAGS.has(name)) skip++;
        if (name === "meta" && (attribs.property ?? "").toLowerCase() === "og:site_name" && attribs.content && !ogName) ogName = cut(squash(attribs.content), MAX_VALUE) || null;
        if (name === "a") {
          closeAnchor();
          if (typeof attribs.href === "string") anchor = { href: attribs.href.trim().slice(0, 2000), label: "" };
        }
        pieces.push(" ");
      },
      ontext(t) {
        if (ld !== null) {
          if (ld.length < MAX_JSONLD_CHARS) ld += t;
          return;
        }
        if (skip > 0) return;
        if (anchor && anchor.label.length < MAX_VALUE) anchor.label += t;
        if (rawLen < MAX_RAW_TEXT) {
          pieces.push(t);
          rawLen += t.length;
        }
      },
      onclosetag(name) {
        depth--;
        if (name === "script" && ld !== null) {
          ldBlocks.push(ld);
          ld = null;
        }
        if (SKIP_TAGS.has(name) && skip > 0) skip--;
        if (name === "a") closeAnchor();
        pieces.push(" ");
      },
      onend() {
        if (ld !== null) ldBlocks.push(ld);
        closeAnchor();
      },
    },
    { decodeEntities: true },
  );
  const input = html.slice(0, MAX_INPUT);
  for (let i = 0; i < input.length; i += CHUNK) {
    if (depth > MAX_DEPTH) {
      facts.depthCapped = true;
      break;
    }
    parser.write(input.slice(i, i + CHUNK));
  }
  parser.end();

  const fullText = squash(pieces.join(""));
  facts.text = fullText.slice(0, MAX_TEXT);

  // JSON-LD
  for (const block of ldBlocks) {
    let data: unknown;
    try {
      data = JSON.parse(block.trim());
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
  facts.name ??= ogName;

  // tel: and mailto: links
  for (const { href, label } of anchors) {
    const text = squash(label);
    if (/^tel:/i.test(href)) {
      let v = href.slice(4);
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      addPhone(v, `${href} ${text}`);
    } else if (/^mailto:/i.test(href)) {
      let v = href.slice(7).split("?")[0];
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      for (const one of v.split(",").slice(0, 5)) if (one.includes("@")) addEmail(one, `${href} ${text}`);
    }
  }

  // e-mails written in the visible text
  for (const { email, at } of emailsIn(facts.text)) addEmail(email, facts.text.slice(Math.max(0, at - 60), at + email.length + 60));

  // phones written in the visible text (same status as tel: phones: found by this reader, not by a model); at most 10
  let textPhones = 0;
  for (const m of fullText.matchAll(NANP)) {
    if (textPhones >= MAX_TEXT_PHONES) break;
    const before = facts.phones.length;
    addPhone(m[0], fullText.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60));
    if (facts.phones.length > before) textPhones++;
  }

  // same-host contact / about links
  const pageHost = hostOf(pageUrl);
  const seenLinks = new Set<string>([pageUrl.replace(/#.*$/, "")]);
  for (const { href, label } of anchors) {
    if (facts.links.length >= 3) break;
    if (!href || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if ((abs.protocol !== "http:" && abs.protocol !== "https:") || hostOf(abs.toString()) !== pageHost) continue;
    abs.hash = "";
    if (!CONTACT_LINK.test(abs.pathname) && !CONTACT_LINK.test(squash(label))) continue;
    const out = abs.toString();
    if (seenLinks.has(out)) continue;
    seenLinks.add(out);
    facts.links.push(out);
  }
  return facts;
}
