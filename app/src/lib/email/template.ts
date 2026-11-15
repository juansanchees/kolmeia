// Template rules for e-mail sequences (client-safe, pure). One template serves many companies (D2): only the three
// merge fields below are allowed. The real renderer is SQL (render_email_template); renderTemplate here is for the
// editor's live preview only and is pinned to SQL by tests/fixtures/template-vectors.ts.
import { bodyProblem, subjectProblem } from "./compose";

export const TEMPLATE_VARS = ["first_name", "company", "city"] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

export type SequenceStep = { step: 1 | 2 | 3; subject: string; body: string };

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

/** Any "{{" or "}}" that is not exactly one of the allowed placeholders is invalid (no spaces, no other names). */
export function templateProblem(text: string): "unknown_var" | null {
  const rest = text.replace(PLACEHOLDER, (m, name: string) => ((TEMPLATE_VARS as readonly string[]).includes(name) ? "" : m));
  return /\{\{|\}\}/.test(rest) ? "unknown_var" : null;
}

/** Every reason a step cannot be saved or approved: subject, body (links, deceptive prefix, size) and placeholders. */
export function stepProblems(s: SequenceStep): string[] {
  const out: string[] = [];
  const sp = subjectProblem(s.subject);
  if (sp) out.push(`subject:${sp}`);
  const bp = bodyProblem(s.body);
  if (bp) out.push(`body:${bp}`);
  if (templateProblem(s.subject) || templateProblem(s.body)) out.push("template:unknown_var");
  return out;
}

export type TemplateVars = { contact_name: string | null; company: string; city: string | null };

/** Preview only: first word of the contact name or "there"; the company; the city or "your area". */
export function renderTemplate(text: string, vars: TemplateVars): string {
  const values: Record<TemplateVar, string> = {
    first_name: vars.contact_name?.trim().split(/\s+/)[0] || "there",
    company: vars.company,
    city: vars.city?.trim() || "your area",
  };
  return text.replace(PLACEHOLDER, (m, name: string) => (name in values ? values[name as TemplateVar] : m));
}
