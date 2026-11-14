import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildFooter,
  bodyProblem,
  ComposeError,
  composeEmail,
  replySubject,
  stripLinks,
  stripReplyPrefix,
  isPublicHttpsOrigin,
  subjectProblem,
  unsubscribeOrigin,
  unsubscribeUrls,
  type ComposeInput,
} from "@/lib/email/compose";
import { parseCloserBrief } from "@/lib/email/brief";
import { getMailboxKey, getMailboxKeys, MailboxKeyError, parseMailboxKey } from "@/lib/email/config";
import { decryptSecret, encryptSecret, keyId, mailboxAad, SecretError } from "@/lib/email/crypto";
import { parseRawEmail } from "@/lib/email/parse";
import {
  addressOf,
  bouncedAddress,
  dsnVerdict,
  isAutoReply,
  isBounce,
  matchIncoming,
  normalizeMessageId,
  parseIdList,
  replyTarget,
  type Incoming,
  type SentRef,
} from "@/lib/email/replies";
import { addBusinessDays, sequenceDates, validDelays } from "@/lib/email/schedule";
import { cleanIncomingText, htmlToText, incomingText, stripQuoted } from "@/lib/email/text";
import { isUnsubToken, UNSUB_TOKEN_RANDOM_BITS } from "@/lib/email/token";
import { mailErrorText } from "@/lib/email/transport";
import { cleanDraftEmail } from "@/lib/ai/email-tasks";

// Pure parts of the E-mail area [R4] [R10] [R12] [R15]: no network, no database.

const KEY = randomBytes(32);
const SENDER = { legal_name: "New England Air HVAC Corp", postal_address: "1 Main St\nMillbury, MA 01527", sender_name: "Juan Sanches" };

describe("mailbox secret: AES-256-GCM [R10]", () => {
  const aad = mailboxAad("ws-1", "Sales@Example.com");

  test("round trip", () => {
    const ct = encryptSecret("abcd efgh ijkl mnop", aad, KEY);
    expect(ct).toMatch(/^v2:[0-9a-f]{8}:[A-Za-z0-9+/]+=*$/);
    expect(ct.split(":")[1]).toBe(keyId(KEY));
    expect(ct).not.toContain("abcd");
    expect(decryptSecret(ct, aad, KEY)).toBe("abcd efgh ijkl mnop");
  });

  test("each encryption uses a fresh IV", () => {
    expect(encryptSecret("same", aad, KEY)).not.toBe(encryptSecret("same", aad, KEY));
  });

  test("tampering with any byte, the tag, or the bound row (AAD) is detected", () => {
    const ct = encryptSecret("secret", aad, KEY);
    const [, id, b64] = ct.split(":");
    const raw = Buffer.from(b64, "base64");
    for (const i of [0, 12, 20, raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[i] ^= 0x01;
      expect(() => decryptSecret(`v2:${id}:${bad.toString("base64")}`, aad, KEY), `byte ${i}`).toThrow(SecretError);
    }
    expect(() => decryptSecret(ct, mailboxAad("ws-2", "sales@example.com"), KEY)).toThrow(/authentication/);
    // another key: its id does not match, so the stored secret names a key this server does not have
    expect(() => decryptSecret(ct, aad, randomBytes(32))).toThrow(/unknown key/);
    expect(() => decryptSecret("v2:abc", aad, KEY)).toThrow(/format/);
    expect(() => decryptSecret("v2:zzzzzzzz:AAAA", aad, KEY)).toThrow(/format/);
    expect(() => decryptSecret("v1:", aad, KEY)).toThrow(/format/);
    expect(() => decryptSecret("v9:x", aad, KEY)).toThrow(/format/);
  });

  test("key rotation: a secret written with the previous key still opens; a legacy v1 secret too", () => {
    const old = randomBytes(32);
    const ring = { current: KEY, previous: old };
    expect(decryptSecret(encryptSecret("pw-old", aad, old), aad, ring)).toBe("pw-old");
    expect(decryptSecret(encryptSecret("pw-new", aad, KEY), aad, ring)).toBe("pw-new");
    // v1 = no key id: every key of the ring is tried
    const v2 = encryptSecret("legacy", aad, old);
    const v1 = `v1:${v2.split(":")[2]}`;
    expect(decryptSecret(v1, aad, ring)).toBe("legacy");
    expect(() => decryptSecret(v1, aad, KEY)).toThrow(/authentication/);
    // once the previous key is gone, its rows ask for a reconnection (SecretError 'key')
    expect(() => decryptSecret(encryptSecret("pw-old", aad, old), aad, { current: KEY, previous: null })).toThrow(SecretError);
    // the safe error code shown to the person: reconnect the mailbox
    expect(mailErrorText(new SecretError("key"))).toBe("mailbox_secret");
  });

  describe("key configuration (lazy)", () => {
    const original = process.env.MAILBOX_ENC_KEY;
    afterEach(() => {
      if (original === undefined) delete process.env.MAILBOX_ENC_KEY;
      else process.env.MAILBOX_ENC_KEY = original;
    });

    test("missing key -> MailboxKeyError('missing'), and encrypting without a key fails", () => {
      process.env.MAILBOX_ENC_KEY = "";
      expect(() => getMailboxKey()).toThrow(MailboxKeyError);
      expect(() => encryptSecret("x", aad)).toThrow(/not configured/);
    });

    test("malformed keys are refused; a good base64 32-byte key is accepted", () => {
      expect(() => parseMailboxKey("short")).toThrow(/32 bytes/);
      expect(() => parseMailboxKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
      expect(() => parseMailboxKey("not base64 !!")).toThrow(/32 bytes/);
      process.env.MAILBOX_ENC_KEY = KEY.toString("base64");
      expect(getMailboxKey().equals(KEY)).toBe(true);
      expect(getMailboxKeys().previous).toBeNull();
      const prev = randomBytes(32);
      process.env.MAILBOX_ENC_KEY_PREVIOUS = prev.toString("base64");
      expect(getMailboxKeys().previous?.equals(prev)).toBe(true);
      process.env.MAILBOX_ENC_KEY_PREVIOUS = "bad";
      expect(() => getMailboxKeys()).toThrow(MailboxKeyError);
      delete process.env.MAILBOX_ENC_KEY_PREVIOUS;
    });

    test("the error message never contains the key", () => {
      const bad = "QUJD" + "x".repeat(10);
      try {
        parseMailboxKey(bad);
      } catch (e) {
        expect(String(e)).not.toContain(bad);
      }
    });
  });
});

describe("R4 subjects, R12 links", () => {
  test.each(["Re: your project", "RE:hi", "Fwd: info", "FW: x", "[Re] x", "(fwd) y", " re : z", "Re[2]: a", "AW: b"])("deceptive: %j", (s) => {
    expect(subjectProblem(s)).toBe("deceptive");
  });
  test.each(["Regarding your Worcester project", "Refrigerant question", "Free estimate?", "Quick question"])("fine: %j", (s) => {
    expect(subjectProblem(s)).toBeNull();
  });
  test("a real reply may start with Re:", () => {
    expect(subjectProblem("Re: Quick question", "reply")).toBeNull();
  });
  test("empty, too long and line breaks", () => {
    expect(subjectProblem("  ")).toBe("empty");
    expect(subjectProblem("x".repeat(151))).toBe("too_long");
    expect(subjectProblem("a\r\nBcc: x@y.z")).toBe("line_break");
  });
  test("links in a sequence body are refused; the footer link is added later", () => {
    expect(bodyProblem("See https://x.example")).toBe("link");
    expect(bodyProblem("visit www.acme.com")).toBe("link");
    expect(bodyProblem("Hi Pat, quick question.")).toBeNull();
    expect(bodyProblem("see https://x.example", "reply")).toBeNull();
  });
  test("stripLinks and stripReplyPrefix clean AI text", () => {
    expect(stripLinks("Hi (https://a.example/x) see www.b.com today.")).toBe("Hi see today.");
    expect(stripReplyPrefix("Re: Fwd: Hello")).toBe("Hello");
    expect(replySubject("RE: Re: Quick question")).toBe("Re: Quick question");
    expect(replySubject("")).toBe("Re: your message");
  });
  test("cleanDraftEmail never returns a deceptive subject or a link", () => {
    expect(cleanDraftEmail("Re: Your permit", "Saw it at https://permits.example. Who does HVAC?")).toEqual({ subject: "Your permit", body: "Saw it at Who does HVAC?" });
    expect(cleanDraftEmail("", "body")).toBeNull();
    expect(cleanDraftEmail("ok", "https://only.example")).toBeNull();
  });
});

describe("R4 footer and headers (CAN-SPAM, RFC 8058)", () => {
  const urls = unsubscribeUrls("https://app.example.com/", "a".repeat(64));
  const input: ComposeInput = {
    kind: "sequence",
    sender: SENDER,
    fromAddress: "Sales@Example.com",
    to: "Pat@Acme.example",
    subject: "Quick question",
    body: "Hi Pat,\r\n\r\nShort note.\r\n\r\nJuan",
    unsubscribe: urls,
    messageId: "<abc@example.com>",
  };

  test("unsubscribe URLs: a page and a one-click endpoint", () => {
    expect(urls).toEqual({ page: `https://app.example.com/u/${"a".repeat(64)}`, oneClick: `https://app.example.com/api/unsubscribe/${"a".repeat(64)}` });
  });

  test("footer carries sender name, legal name, postal address and the unsubscribe link", () => {
    const f = buildFooter(SENDER, urls.page);
    expect(f).toBe(
      ["--", "Juan Sanches", "New England Air HVAC Corp", "1 Main St", "Millbury, MA 01527", "", `If you'd rather not hear from us, unsubscribe here: ${urls.page}`].join("\n"),
    );
  });

  test("the exact outgoing message: plain text, footer, List-Unsubscribe + One-Click headers", () => {
    const m = composeEmail(input);
    expect(m.from).toEqual({ name: "Juan Sanches", address: "sales@example.com" });
    expect(m.to).toBe("pat@acme.example");
    expect(m.text.startsWith("Hi Pat,\n\nShort note.\n\nJuan\n\n--\nJuan Sanches\nNew England Air HVAC Corp\n")).toBe(true);
    expect(m.text).toContain(urls.page);
    expect(m.text).not.toContain("\r");
    expect(m.headers).toEqual({ "List-Unsubscribe": `<${urls.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(m.messageId).toBe("<abc@example.com>");
    expect(m.inReplyTo).toBeNull();
    // R12: the only link in the whole message is the unsubscribe page
    expect(m.text.match(/https?:\/\//g)).toHaveLength(1);
  });

  test("a reply carries In-Reply-To and References", () => {
    const m = composeEmail({ ...input, kind: "reply", subject: "Re: Quick question", inReplyTo: "<their@acme.example>" });
    expect(m.inReplyTo).toBe("<their@acme.example>");
    expect(m.references).toEqual(["<their@acme.example>"]);
  });

  test("refuses to compose when a rule would break", () => {
    const cases: Array<[Partial<ComposeInput>, string]> = [
      [{ sender: { ...SENDER, postal_address: "" } }, "sender_incomplete"],
      [{ sender: { ...SENDER, legal_name: " " } }, "sender_incomplete"],
      [{ subject: "Re: hello" }, "deceptive"],
      [{ body: "go to www.x.com" }, "link"],
      [{ to: "not-an-address" }, "address"],
      [{ unsubscribe: { page: "http://evil.example/u", oneClick: urls.oneClick } }, "unsubscribe_url"],
      [{ unsubscribe: { page: "javascript:alert(1)", oneClick: urls.oneClick } }, "unsubscribe_url"],
    ];
    for (const [patch, code] of cases) {
      expect(() => composeEmail({ ...input, ...patch }), code).toThrow(ComposeError);
      try {
        composeEmail({ ...input, ...patch });
      } catch (e) {
        expect((e as ComposeError).code).toBe(code);
      }
    }
  });

  test("header values lose control characters (no header injection through the sender name)", () => {
    const m = composeEmail({ ...input, sender: { ...SENDER, sender_name: "Juan\r\nBcc: x@evil.example" } });
    expect(m.from.name).not.toMatch(/[\r\n]/);
  });
});

describe("business days", () => {
  test("weekends are skipped (UTC)", () => {
    const fri = new Date("2026-11-13T15:00:00Z");
    expect(addBusinessDays(fri, 1).toISOString()).toBe("2026-11-16T15:00:00.000Z");
    expect(addBusinessDays(fri, 3).toISOString()).toBe("2026-11-18T15:00:00.000Z");
    expect(addBusinessDays(new Date("2026-11-12T10:00:00Z"), 7).toISOString()).toBe("2026-11-23T10:00:00.000Z");
    expect(addBusinessDays(new Date("2026-11-14T10:00:00Z"), 1).toISOString()).toBe("2026-11-16T10:00:00.000Z"); // Saturday
    expect(addBusinessDays(fri, 0).toISOString()).toBe(fri.toISOString());
  });
  test("default sequence: day 0, +3 and +7 business days; delays validated", () => {
    const d = sequenceDates(new Date("2026-11-10T14:00:00Z"), { step2: 3, step3: 7 });
    expect(d.step2.toISOString().slice(0, 10)).toBe("2026-11-13");
    expect(d.step3.toISOString().slice(0, 10)).toBe("2026-11-19");
    expect(validDelays({ step2: 3, step3: 7 })).toBe(true);
    expect(validDelays({ step2: 5, step3: 5 })).toBe(false);
    expect(validDelays({ step2: 0, step3: 7 })).toBe(false);
    expect(validDelays({ step2: 3, step3: 61 })).toBe(false);
  });
});

describe("incoming text is reduced to bounded plain text [R15]", () => {
  test("HTML is stripped (scripts, styles, tags), entities decoded", () => {
    const t = htmlToText('<style>p{}</style><p>Hi &amp; thanks</p><script>alert(1)</script><div>Call me<br>Tue</div><img src=x onerror=alert(1)>');
    expect(t).toBe("Hi & thanks\nCall me\nTue\n");
    expect(t).not.toMatch(/<|script|onerror/);
  });
  test("quoted history and control characters are removed, size is capped", () => {
    expect(stripQuoted("Sounds good.\n\nOn Tue, Nov 10, 2026 at 9:00 AM Juan <j@x.com> wrote:\n> old text")).toBe("Sounds good.\n");
    expect(stripQuoted("Yes\n> quoted\nmore")).toBe("Yes\nmore");
    expect(cleanIncomingText("a\u0000b‮c\r\n\r\n\r\n\r\nd")).toBe("abc\n\nd");
    expect(cleanIncomingText("x".repeat(30_000)).length).toBe(20_000);
    expect(incomingText({ text: null, html: "<b>Yes</b>, interested" })).toBe("Yes, interested");
  });
});

describe("reply matching and bounces", () => {
  const sent: SentRef[] = [
    { messageRowId: "m1", prospectId: "p1", rfcMessageId: "<aaa@gmail.com>", toAddress: "pat@acme.example", sentAt: "2026-11-01T10:00:00Z" },
    { messageRowId: "m2", prospectId: "p2", rfcMessageId: "<bbb@gmail.com>", toAddress: "lee@beta.example", sentAt: "2026-11-02T10:00:00Z" },
    { messageRowId: "m3", prospectId: "p3", rfcMessageId: "<ccc@gmail.com>", toAddress: "lee@beta.example", sentAt: "2026-11-05T10:00:00Z" },
  ];
  const base: Incoming = {
    messageId: "<x1@acme.example>",
    from: "someone@else.example",
    subject: "Re: Quick question",
    inReplyTo: null,
    references: [],
    text: "Sure",
    date: new Date("2026-11-06T10:00:00Z"),
    contentType: "text/plain",
    autoSubmitted: null,
    failedRecipients: null,
    report: null,
  };

  test("by In-Reply-To first, then References", () => {
    expect(matchIncoming({ ...base, inReplyTo: "<AAA@gmail.com>" }, sent)).toEqual({ prospectId: "p1", messageRowId: "m1", via: "thread", kind: "reply", bouncedAddress: null });
    expect(matchIncoming({ ...base, references: ["<zzz@x>", "<bbb@gmail.com>"] }, sent)).toMatchObject({ prospectId: "p2", via: "thread" });
  });
  test("fallback: sender address = prospect address, latest send wins", () => {
    expect(matchIncoming({ ...base, from: "Lee@Beta.example" }, sent)).toEqual({ prospectId: "p3", messageRowId: "m3", via: "address", kind: "reply", bouncedAddress: null });
  });
  test("unrelated mail matches nothing", () => {
    expect(matchIncoming(base, sent)).toBeNull();
  });
  const dsn: Incoming = {
    ...base,
    from: "mailer-daemon@googlemail.com",
    subject: "Delivery Status Notification (Failure)",
    contentType: "multipart/report; report-type=delivery-status",
    text: "Address not found",
  };

  test("genuine DSN: quotes OUR Message-ID and says failed / 5.x.x -> automatic bounce", () => {
    const genuine = { ...dsn, report: "Final-Recipient: rfc822; pat@acme.example\nAction: failed\nStatus: 5.1.1\n\nMessage-ID: <aaa@gmail.com>" };
    expect(isBounce(genuine)).toBe(true);
    expect(dsnVerdict(genuine)).toBe("failed");
    expect(bouncedAddress(genuine)).toBe("pat@acme.example");
    expect(matchIncoming(genuine, sent)).toEqual({ prospectId: "p1", messageRowId: "m1", via: "thread", kind: "bounce", bouncedAddress: "pat@acme.example" });
    // only Status 5.x.x (no Action line) is a failure too
    expect(matchIncoming({ ...dsn, report: "Status: 5.2.2\nMessage-ID: <bbb@gmail.com>" }, sent)).toMatchObject({ prospectId: "p2", kind: "bounce" });
  });

  test("forged DSN: names an address we mailed but not our Message-ID -> only a possible bounce (a person decides)", () => {
    const forged = { ...dsn, from: "postmaster@evil.example", report: "Final-Recipient: rfc822; lee@beta.example\nAction: failed\nStatus: 5.1.1" };
    expect(matchIncoming(forged, sent)).toEqual({ prospectId: "p3", messageRowId: "m3", via: "address", kind: "possible_bounce", bouncedAddress: "lee@beta.example" });
    // the X-Failed-Recipients header alone proves nothing either
    expect(matchIncoming({ ...dsn, failedRecipients: "pat@acme.example", text: "Status: 5.1.1" }, sent)).toMatchObject({ prospectId: "p1", kind: "possible_bounce" });
    // a Message-ID that is not ours is no proof
    expect(matchIncoming({ ...forged, report: `${forged.report}\nMessage-ID: <zzz@gmail.com>` }, sent)).toMatchObject({ kind: "possible_bounce" });
  });

  test("delayed DSN (Action: delayed / Status: 4.x.x) is ignored, even with our Message-ID", () => {
    const delayed = { ...dsn, subject: "Delivery Status Notification (Delay)", report: "Final-Recipient: rfc822; pat@acme.example\nAction: delayed\nStatus: 4.4.7\nMessage-ID: <aaa@gmail.com>" };
    expect(dsnVerdict(delayed)).toBe("delayed");
    expect(matchIncoming(delayed, sent)).toBeNull();
    expect(matchIncoming({ ...dsn, text: "Status: 4.2.2 mailbox full", failedRecipients: "pat@acme.example" }, sent)).toBeNull();
  });

  test("our Message-ID without any failure field -> possible bounce; nothing matches -> ignored", () => {
    expect(matchIncoming({ ...dsn, text: "Original message: Message-ID: <bbb@gmail.com>" }, sent)).toMatchObject({ prospectId: "p2", via: "thread", kind: "possible_bounce" });
    expect(matchIncoming({ ...dsn, report: "Final-Recipient: rfc822; nobody@else.example\nAction: failed" }, sent)).toBeNull();
  });

  test("our answer to a reply goes to the replier only when it is the prospect's address or domain", () => {
    expect(replyTarget("Pat <pat@acme.example>", "pat@acme.example")).toBe("pat@acme.example");
    expect(replyTarget("jo@acme.example", "pat@acme.example")).toBe("jo@acme.example");
    expect(replyTarget("x@other.example", "pat@acme.example")).toBe("pat@acme.example");
    // a shared free-mail domain is not "their domain"
    expect(replyTarget("stranger@gmail.com", "pat@gmail.com")).toBe("pat@gmail.com");
    expect(replyTarget(null, "pat@acme.example")).toBe("pat@acme.example");
  });

  test("a person's reply is not a bounce; auto-replies are recognised", () => {
    expect(isBounce({ ...base, from: "pat@acme.example" })).toBe(false);
    expect(isAutoReply({ ...base, autoSubmitted: "auto-replied" })).toBe(true);
    expect(isAutoReply({ ...base, subject: "Out of Office: back Monday" })).toBe(true);
    expect(isAutoReply(base)).toBe(false);
  });
  test("ids and addresses are normalised", () => {
    expect(normalizeMessageId(" <ABC@Host> ")).toBe("<abc@host>");
    expect(normalizeMessageId("garbage")).toBeNull();
    expect(parseIdList("<a@b> <c@d>")).toEqual(["<a@b>", "<c@d>"]);
    expect(addressOf('"Pat" <Pat@Acme.example>')).toBe("pat@acme.example");
  });
});

describe("raw message parsing (mailparser, offline)", () => {
  test("a plain reply: ids, sender, own text without the quoted history", async () => {
    const raw = [
      "From: Pat Doe <Pat@Acme.example>",
      "To: sales@example.com",
      "Subject: Re: Quick question",
      "Message-ID: <reply-1@acme.example>",
      "In-Reply-To: <aaa@gmail.com>",
      "References: <aaa@gmail.com>",
      "Date: Fri, 06 Nov 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Yes, call me Tuesday.",
      "",
      "On Thu, Nov 5, 2026 at 9:00 AM Juan <sales@example.com> wrote:",
      "> Hi Pat",
    ].join("\r\n");
    const m = await parseRawEmail(Buffer.from(raw));
    expect(m).toMatchObject({ messageId: "<reply-1@acme.example>", from: "pat@acme.example", inReplyTo: "<aaa@gmail.com>", references: ["<aaa@gmail.com>"], text: "Yes, call me Tuesday." });
  });

  test("HTML-only mail becomes text; scripts never survive", async () => {
    const raw = ["From: a@b.example", "Subject: hi", "Message-ID: <h@b.example>", "Content-Type: text/html; charset=utf-8", "", "<p>Interested!</p><script>steal()</script>"].join("\r\n");
    const m = await parseRawEmail(Buffer.from(raw));
    expect(m.text).toBe("Interested!");
  });

  test("a DSN's machine parts (delivery-status fields, original headers) are read; the original body is not kept", async () => {
    const raw = [
      "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      "Subject: Delivery Status Notification (Failure)",
      "Message-ID: <dsn-2@google.com>",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b2"',
      "",
      "--b2",
      "Content-Type: text/plain",
      "",
      "Address not found",
      "--b2",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; googlemail.com",
      "",
      "Final-Recipient: rfc822; pat@acme.example",
      "Action: failed",
      "Status: 5.1.1",
      "--b2",
      "Content-Type: message/rfc822",
      "",
      "Message-ID: <aaa@gmail.com>",
      "Subject: Quick question",
      "",
      "SECRET ORIGINAL BODY",
      "--b2--",
    ].join("\r\n");
    const m = await parseRawEmail(Buffer.from(raw));
    // mailparser inlines message/delivery-status into the text and keeps message/rfc822 as a part: both are read
    expect(dsnVerdict(m)).toBe("failed");
    expect(m.report).toMatch(/<aaa@gmail\.com>/);
    expect(m.report ?? "").not.toMatch(/SECRET ORIGINAL BODY/);
    expect(matchIncoming(m, [{ messageRowId: "m1", prospectId: "p1", rfcMessageId: "<aaa@gmail.com>", toAddress: "pat@acme.example", sentAt: "2026-11-01T10:00:00Z" }])).toMatchObject({ kind: "bounce", bouncedAddress: "pat@acme.example" });
  });

  test("a DSN keeps the report content type and the failed recipient header", async () => {
    const raw = [
      "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      "Subject: Delivery Status Notification (Failure)",
      "Message-ID: <dsn-1@google.com>",
      "X-Failed-Recipients: pat@acme.example",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "Address not found",
      "--b1--",
    ].join("\r\n");
    const m = await parseRawEmail(Buffer.from(raw));
    expect(isBounce(m)).toBe(true);
    expect(bouncedAddress(m)).toBe("pat@acme.example");
  });
});

describe("unsubscribe origin: real mail only on APP_PUBLIC_ORIGIN (https, public host) [R4]", () => {
  test.each(["https://app.example.com", "https://app.example.com/", "https://radar.vercel.app"])("public: %s", (o) => {
    expect(isPublicHttpsOrigin(o)).toBe(true);
  });
  test.each(["http://app.example.com", "https://localhost:3000", "https://127.0.0.1", "https://[::1]", "https://intranet", "https://x.localhost", "https://app.example.com/path", "https://u:p@app.example.com", "", null, "not a url"])(
    "refused: %s",
    (o) => {
      expect(isPublicHttpsOrigin(o)).toBe(false);
    },
  );
  test("real mail uses only the configured origin, never the request's; rehearsal may fall back", () => {
    expect(unsubscribeOrigin(true, "https://app.example.com/", "https://evil.example")).toBe("https://app.example.com");
    expect(unsubscribeOrigin(true, null, "https://evil.example")).toBeNull();
    expect(unsubscribeOrigin(true, "http://localhost:3000", "http://localhost:3000")).toBeNull();
    expect(unsubscribeOrigin(false, null, "http://localhost:3221")).toBe("http://localhost:3221");
    expect(unsubscribeOrigin(false, "https://app.example.com", "http://localhost:3221")).toBe("https://app.example.com");
  });
  test("composeEmail with strictOrigin refuses localhost / http unsubscribe links", () => {
    const base: ComposeInput = {
      kind: "sequence",
      sender: SENDER,
      fromAddress: "sales@example.com",
      to: "pat@acme.example",
      subject: "Quick question",
      body: "Hi Pat",
      unsubscribe: unsubscribeUrls("http://localhost:3000", "a".repeat(64)),
      messageId: "<x@example.com>",
    };
    expect(() => composeEmail(base)).not.toThrow();
    expect(() => composeEmail({ ...base, strictOrigin: true })).toThrow(/unsubscribe_url/);
    expect(() => composeEmail({ ...base, strictOrigin: true, unsubscribe: unsubscribeUrls("https://app.example.com", "a".repeat(64)) })).not.toThrow();
  });
});

describe("closer brief is parsed defensively [R15]", () => {
  test("a valid brief keeps only safe links; a bad shape gives null instead of crashing the page", () => {
    const ok = parseCloserBrief({ who: "Acme", what_they_said: "Call Tue", next_step: "Call", evidence_urls: ["https://permits.example/1", "javascript:alert(1)", "https://www.linkedin.com/in/x"], model: "m" });
    expect(ok?.evidence_urls).toEqual(["https://permits.example/1"]);
    for (const bad of [null, "x", [], { who: 1 }, { who: "a", what_they_said: "b", next_step: "c", evidence_urls: "https://x.example", model: "m" }]) {
      expect(parseCloserBrief(bad)).toBeNull();
    }
  });
});

describe("unsubscribe token and safe error text [R10]", () => {
  test("only 64 lower-case hex characters are accepted; >= 128 random bits", () => {
    expect(isUnsubToken("a".repeat(64))).toBe(true);
    for (const bad of ["A".repeat(64), "a".repeat(63), "../etc/passwd", "", null, 42]) expect(isUnsubToken(bad)).toBe(false);
    expect(UNSUB_TOKEN_RANDOM_BITS).toBeGreaterThanOrEqual(128);
  });
  test("SMTP/IMAP errors are reduced to a short code without credentials", () => {
    expect(mailErrorText(Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 }))).toBe("auth_failed");
    const t = mailErrorText(Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:465\nstack"), { code: "ETIMEDOUT" }));
    expect(t).toBe("ETIMEDOUT connect ETIMEDOUT 1.2.3.4:465");
    expect(mailErrorText("x")).toBe("unknown error");
  });
});
