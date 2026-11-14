// Shared by tests/db/leads.test.ts: the SQL company keys (0009) must agree with lib/research/dedupe.ts on these.
export const WEBSITE_VECTORS: string[] = [
  "https://www.acme.com/contact",
  "http://ACME.com",
  "https://acme.com.",
  "https://facebook.com/acme",
  "https://m.facebook.com/acme",
  "https://acme.wixsite.com/site",
  "https://sites.google.com/view/acme",
  "https://notfacebook.com/acme",
  "https://acme.com:8080/x?y=1",
  "ftp://acme.com",
  "not a url",
  "",
];

export const PHONE_VECTORS: string[] = ["+1 (508) 555-0199", "508.555.0199", "15085550199", "555-0199", "ext 12", ""];
