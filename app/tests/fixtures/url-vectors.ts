// One vector list for both sides of the URL rules (finding 10): src/lib/safe-url.ts (TypeScript) and
// public.is_safe_url / public.url_host (SQL, migration 0004). Both test files assert every row.
// [input, safe?, host as url_host/hostOf returns it (null = not an http(s) URL)]
export const URL_VECTORS: Array<[string, boolean, string | null]> = [
  ["https://acmebuilders.example/about", true, "acmebuilders.example"],
  ["https://www.Acme.example/x?y=1#z", true, "acme.example"],
  ["http://permits.town.example:8080/search", true, "permits.town.example"],
  ["https://linkedin.com/in/ceo", false, "linkedin.com"],
  ["https://www.linkedin.com/company/x", false, "linkedin.com"],
  ["https://br.linkedin.com/in/x", false, "br.linkedin.com"],
  ["https://linkedin.com./in/x", false, "linkedin.com"],
  ["https://www.linkedin.com../x", false, "linkedin.com"],
  ["https://LNKD.IN/abc", false, "lnkd.in"],
  ["https://notlinkedin.com/x", true, "notlinkedin.com"],
  ["https://example.com./path", true, "example.com"],
  ["https://user:pass@acme.example/", false, "acme.example"],
  ["https://127.0.0.1/admin", false, "127.0.0.1"],
  ["http://10.0.0.5:3000/", false, "10.0.0.5"],
  ["http://[::1]/", false, "[::1]"],
  ["http://[2001:db8::1]:8080/x", false, "[2001:db8::1]"],
  ["http://localhost:3000/", false, "localhost"],
  ["http://metadata.internal/latest", false, "metadata.internal"],
  ["http://printer.local/", false, "printer.local"],
  ["http://intranet/", false, "intranet"],
  ["javascript:alert(1)", false, null],
  ["ftp://files.example/x", false, null],
  ["http://192.168.1.1/router", false, "192.168.1.1"],
];
