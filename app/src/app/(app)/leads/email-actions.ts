"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { checkEmails, planEmailCheck, SAVE_CHUNK, systemLookup, type EmailVerdict } from "@/lib/leads/email-check";
import { findEmails, type FindEmailResult } from "@/lib/leads/email-cascade";
import { emailChecksOf, inLeadChunks, listLeads } from "@/lib/leads/queries";
import { LEAD_FIELD_COLUMNS, type LeadFieldRow } from "@/lib/leads/types";
import { emailVerifier } from "@/lib/leads/email-verifier";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill, t } from "@/messages/pt";

const Q = t.leads.emailQuality;
const FE = t.leads.findEmail;

/** Leads per "Checar e-mails" click and addresses looked up per click. */
const CHECK_MAX_LEADS = 500;
const CHECK_MAX_EMAILS = 200;
/** Leads per "Achar e-mail" click (each may need one DNS look-up and, when configured, a few paid verifications). */
const FIND_MAX_LEADS = 25;

const idsOf = (max: number) => z.array(z.string().uuid()).min(1).max(max);

/** The selected leads' non-refuted values of these kinds (guesses included; callers filter), read as the user (RLS). */
function emailFields(db: SupabaseClient, workspaceId: string, ids: string[], kinds: string[]): Promise<LeadFieldRow[]> {
  return inLeadChunks<LeadFieldRow>(
    ids,
    (c) => db.from("lead_fields").select(LEAD_FIELD_COLUMNS).eq("workspace_id", workspaceId).in("lead_id", c).in("field", kinds).neq("status", "refuted") as never,
    "emailFields",
  );
}

type CheckOut = { ok: true; message: string } | { ok: false; error: string };

/**
 * Free check (syntax + DNS; no SMTP, no paid call) of every address a campaign could pick for the selected leads: the
 * shown one and each non-refuted e-mail value that is not a guess. Saved 25 at a time, so a timeout keeps what was done.
 */
export async function checkEmailsAction(leadIds: string[]): Promise<CheckOut> {
  const workspace = await requireSender();
  const parsed = idsOf(CHECK_MAX_LEADS).safeParse(leadIds);
  if (!parsed.success) return { ok: false, error: fill(Q.tooMany, { n: CHECK_MAX_LEADS }) };
  const db = await createClient();
  if (!db) return { ok: false, error: Q.failed };
  try {
    const [items, fields] = await Promise.all([listLeads(db, workspace.id, { ids: parsed.data }), emailFields(db, workspace.id, parsed.data, ["email"])]);
    const emails = [
      ...items.map((i) => i.display.email),
      ...fields.filter((f) => f.source !== "pattern").map((f) => f.value),
    ].filter((e): e is string => Boolean(e?.trim()));
    if (emails.length === 0) return { ok: false, error: Q.noEmails };
    const plan = planEmailCheck(emails, await emailChecksOf(db, workspace.id, emails), Date.now(), CHECK_MAX_EMAILS);
    const lookup = systemLookup();
    const done: EmailVerdict[] = [];
    for (let i = 0; i < plan.todo.length; i += SAVE_CHUNK) {
      const verdicts = await checkEmails(plan.todo.slice(i, i + SAVE_CHUNK), lookup);
      const { error } = await db
        .from("email_checks")
        .upsert(verdicts.map((v) => ({ workspace_id: workspace.id, email: v.email, status: v.status, method: "mx", detail: v.detail })), { onConflict: "workspace_id,email" });
      if (error) break; // what was saved stays saved; the message counts only that
      done.push(...verdicts);
    }
    const n = (s: string) => done.filter((v) => v.status === s).length;
    revalidatePath("/leads");
    if (done.length < plan.todo.length && done.length === 0) return { ok: false, error: Q.failed };
    const message = fill(Q.checked, { n: done.length, domainOk: n("domain_ok"), invalid: n("invalid"), unknown: n("unknown"), skipped: plan.skipped });
    const left = plan.cut + (plan.todo.length - done.length);
    return { ok: true, message: left > 0 ? `${message} ${fill(Q.cut, { n: left, max: CHECK_MAX_EMAILS })}` : message };
  } catch {
    return { ok: false, error: Q.failed };
  }
}

type FindOut = { ok: true; results: FindEmailResult[]; verifierConfigured: boolean } | { ok: false; error: string };

/** The e-mail cascade for the selected leads: e-mail on file -> the site via RapidAPI -> pattern guesses -> paid verifier (EMAIL_VERIFIER). */
export async function findEmailAction(leadIds: string[]): Promise<FindOut> {
  const workspace = await requireSender();
  const parsed = idsOf(FIND_MAX_LEADS).safeParse(leadIds);
  if (!parsed.success) return { ok: false, error: fill(FE.tooMany, { n: FIND_MAX_LEADS }) };
  const db = await createClient();
  if (!db) return { ok: false, error: FE.failed };
  try {
    const [items, fields] = await Promise.all([listLeads(db, workspace.id, { ids: parsed.data }), emailFields(db, workspace.id, parsed.data, ["email", "contact_name", "website"])]);
    const addresses = [...fields.filter((f) => f.field === "email").map((f) => f.value), ...items.map((i) => i.best?.public_email ?? "")].filter(Boolean);
    const checks = await emailChecksOf(db, workspace.id, addresses);
    const invalid = new Set([...checks.values()].filter((c) => c.status === "invalid").map((c) => c.email));
    const verifier = emailVerifier();
    const results = await findEmails(
      items.map((i) => ({ item: i, fields: fields.filter((f) => f.lead_id === i.lead.id) })),
      {
        lookup: systemLookup(),
        verifier,
        invalid,
        addGuesses: async (rows) => {
          const { error } = await db.from("lead_fields").insert(rows.map((r) => ({ workspace_id: workspace.id, lead_id: r.leadId, field: "email", value: r.email, source: "pattern", source_ref: r.pattern, status: "unverified", excerpt: r.excerpt })));
          if (error && error.code !== "23505") throw new Error(`addGuesses: ${error.message}`);
        },
        // RapidAPI's site reader (queued for the sources clock); without a connection or room this month it says false
        readSite: async (leadId, url) => {
          const { data, error } = await db.rpc("request_site_contact", { p_ws: workspace.id, p_lead: leadId, p_url: url });
          return !error && data === true;
        },
        // Server-side only by design: record_verifier_verdict is not executable by any client role, so this call fails
        // until a vendor and a server-side caller are set up (none is; the step is skipped while EMAIL_VERIFIER = none).
        saveVerdict: async (email, status) => {
          const { error } = await db.rpc("record_verifier_verdict", { p_ws: workspace.id, p_email: email, p_status: status, p_verifier: verifier?.name ?? "" });
          if (error) throw new Error(`saveVerdict: ${error.message}`);
        },
      },
    );
    revalidatePath("/leads");
    for (const id of parsed.data) revalidatePath(`/leads/${id}`);
    return { ok: true, results, verifierConfigured: verifier !== null };
  } catch {
    return { ok: false, error: FE.failed };
  }
}
