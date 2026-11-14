import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// P2 network layer: only public addresses are ever connected to. The check runs on every resolved address (inside the
// socket's own `lookup`, so there is no gap between "checked" and "connected") and on IP-literal hosts before any DNS.

const blocked = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(a, p, "ipv4");
blocked.addAddress("255.255.255.255", "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
for (const [a, p] of [["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96]] as const) blocked.addSubnet(a, p, "ipv6");

/** IPv4 inside an IPv6 literal ("::ffff:127.0.0.1" or "::ffff:7f00:1"), else null. */
function mappedV4(ip: string): string | null {
  const m = /^(?:0{0,4}:){2,5}(?:ffff:)(.+)$/i.exec(ip) ?? /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const rest = m[1];
  if (net.isIPv4(rest)) return rest;
  const h = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!h) return null;
  const hi = parseInt(h[1], 16);
  const lo = parseInt(h[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = net.isIP(s);
  if (!kind) return false;
  if (kind === 4) return !blocked.check(s, "ipv4");
  const v4 = mappedV4(s);
  if (v4) return !blocked.check(v4, "ipv4");
  return !blocked.check(s, "ipv6");
}

function blockedError(host: string): Error & { code: string } {
  return Object.assign(new Error(`blocked_address: ${host}`), { code: "blocked_address" });
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** The `lookup` option of node:http. Always resolves every address; refuses when any of them is not public. */
export function safeLookup(hostname: string, options: dns.LookupOptions | LookupCb, callback?: LookupCb): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCb;
  const opts = typeof options === "function" ? {} : options;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err, [] as dns.LookupAddress[]);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) return cb(blockedError(hostname), [] as dns.LookupAddress[]);
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export type RawResponse = { status: number; headers: Record<string, string>; body: string; truncated: boolean };

export interface RawHttp {
  get(url: string, o: { timeoutMs: number; maxBytes: number; userAgent: string; accept: string }): Promise<RawResponse>;
}

export const nodeRawHttp: RawHttp = {
  get(rawUrl, o) {
    return new Promise<RawResponse>((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(rawUrl);
      } catch {
        return reject(Object.assign(new Error("bad url"), { code: "bad_url" }));
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return reject(Object.assign(new Error("bad scheme"), { code: "bad_url" }));
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(host) && !isPublicAddress(host)) return reject(blockedError(host));

      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        u,
        { method: "GET", agent: false, lookup: safeLookup as never, headers: { "user-agent": o.userAgent, accept: o.accept, "accept-encoding": "identity" } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          const end = () => finish(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8"), truncated }));
          res.on("data", (c: Buffer) => {
            const room = o.maxBytes - size;
            if (c.length > room) {
              if (room > 0) chunks.push(c.subarray(0, room));
              size = o.maxBytes;
              truncated = true;
              res.destroy();
              end();
              return;
            }
            chunks.push(c);
            size += c.length;
          });
          res.on("end", end);
          res.on("error", (e) => finish(() => reject(e)));
          res.on("close", end);
        },
      );
      const timer = setTimeout(() => {
        const err = Object.assign(new Error("timeout"), { code: "timeout" });
        finish(() => reject(err));
        req.destroy();
      }, o.timeoutMs);
      req.on("error", (e: NodeJS.ErrnoException & { errors?: { code?: string }[] }) => {
        const code = e.code === "blocked_address" || e.errors?.some((x) => x.code === "blocked_address") ? "blocked_address" : e.code;
        finish(() => reject(code === e.code ? e : Object.assign(new Error(e.message), { code })));
      });
      req.end();
    });
  },
};
