// Shared by tests/unit/email-sequence.test.ts (TS renderTemplate) and tests/db (SQL render_email_template):
// both renderers must give `out` for `text` with these values (D2).
export type TemplateVector = {
  text: string;
  contact_name: string | null;
  company: string;
  city: string | null;
  out: string;
};

export const TEMPLATE_VECTORS: TemplateVector[] = [
  { text: "Hi {{first_name}}, {{company}} in {{city}}?", contact_name: "Pat Doe", company: "Acme HVAC", city: "Worcester", out: "Hi Pat, Acme HVAC in Worcester?" },
  { text: "Hi {{first_name}},", contact_name: null, company: "Acme", city: null, out: "Hi there," },
  { text: "Hi {{first_name}},", contact_name: "   ", company: "Acme", city: null, out: "Hi there," },
  { text: "Hi {{first_name}},", contact_name: "  Maria   de Souza ", company: "Acme", city: null, out: "Hi Maria," },
  { text: "Work in {{city}}", contact_name: null, company: "Acme", city: "", out: "Work in your area" },
  { text: "Work in {{city}}", contact_name: null, company: "Acme", city: "  Boston ", out: "Work in Boston" },
  { text: "{{company}} / {{company}}", contact_name: null, company: "Acme & Sons", city: null, out: "Acme & Sons / Acme & Sons" },
  { text: "No fields here.", contact_name: "Pat", company: "Acme", city: "X", out: "No fields here." },
  // One pass only: a value that looks like a placeholder is never expanded again.
  { text: "{{company}}", contact_name: null, company: "{{city}} Co", city: "Boston", out: "{{city}} Co" },
  // Unicode and tab separators: JS and Postgres must agree on what a first word is.
  { text: "Hi {{first_name}},", contact_name: "\tPat\tDoe", company: "Acme", city: null, out: "Hi Pat," },
  { text: "Hi {{first_name}},", contact_name: "\u00a0Pat Doe", company: "Acme", city: null, out: "Hi Pat," },
  // A title, an initial or an e-mail is not a first name.
  { text: "Hi {{first_name}},", contact_name: "Dr. Pat Doe", company: "Acme", city: null, out: "Hi there," },
  { text: "Hi {{first_name}},", contact_name: "info@acme.com", company: "Acme", city: null, out: "Hi there," },
];
