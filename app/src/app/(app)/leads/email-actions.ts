"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { checkEmails, systemLookup } from "@/lib/leads/email-check";
import { findEmails, type FindEmailResult } from "@/lib/leads/email-cascade";
import { emailChecksOf, inLeadChunks, listLeads } from "@/lib/leads/queries";
import { LEAD_FIELD_COLUMNS, type LeadFieldRow } from "@/lib/leads/types";
import { emailVerifier } from "@/lib/leads/email-verifier";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill, t } from "@/messages/pt";

const Q = t.leads.emailQuality;
const FE = t.leads.findEmail;

/** Leads per "Checar e-mails" click, addresses looked up per click, and how long a free verdict is reused. */
const CHECK_MAX_LEADS = 500;
const CHECK_MAX_EMAILS = 200;
const FRESH_MS = 7 * 86_400_000;
/** Leads per "Achar e-mail" click (each may need one DNS look-up and, when configured, a few paid verifications). */
const FIND_MAX_LEADS = 25;

const idsOf = (max: number) => z.array(z.string().uuid()).min(1).max(max);

type CheckOut = { ok: true; message: string } | { ok: false; error: string };

/** Free check of the selected leads' e-mails: syntax + DNS (no SMTP, no paid call). A verifier verdict is never overwritten. */
export async function checkEmailsAction(leadIds: string[]): Promise<CheckOut> {
  const workspace = await requireSender();
  const parsed = idsOf(CHECK_MAX_LEADS).safeParse(leadIds);
  if (!parsed.success) return { ok: false, error: fill(Q.tooMany, { n: CHECK_MAX_LEADS }) };
  const db = await createClient();
  if (!db) return { ok: false, error: Q.failed };
  try {
    const items = await listLeads(db, workspace.id, { ids: parsed.data });
    const emails = [...new Set(items.map((i) => i.display.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)))];
    if (emails.length === 0) return { ok: false, error: Q.noEmails };
    const known = await emailChecksOf(db, workspace.id, emails);
    const now = Date.now();
    const fresh = (e: string) => {
      const k = known.get(e);
      return Boolean(k && (k.method === "verifier" || now - Date.parse(k.checked_at) < FRESH_MS));
    };
    const todo = emails.filter((e) => !fresh(e)).slice(0, CHECK_MAX_EMAILS);
    const verdicts = await checkEmails(todo, systemLookup());
    if (verdicts.length > 0) {
      const { error } = await db
        .from("email_checks")
        .upsert(verdicts.map((v) => ({ workspace_id: workspace.id, email: v.email, status: v.status, method: "mx", detail: v.detail })), { onConflict: "workspace_id,email" });
      if (error) return { ok: false, error: Q.failed };
    }
    const n = (s: string) => verdicts.filter((v) => v.status === s).length;
    revalidatePath("/leads");
    return { ok: true, message: fill(Q.checked, { n: verdicts.length, verified: n("verified"), invalid: n("invalid"), unknown: n("unknown"), skipped: emails.length - verdicts.length }) };
  } catch {
    return { ok: false, error: Q.failed };
  }
}

type FindOut = { ok: true; results: FindEmailResult[]; verifierConfigured: boolean } | { ok: false; error: string };

/** The e-mail cascade for the selected leads: e-mail on file -> pattern guesses -> paid verifier (EMAIL_VERIFIER). */
export async function findEmailAction(leadIds: string[]): Promise<FindOut> {
  const workspace = await requireSender();
  const parsed = idsOf(FIND_MAX_LEADS).safeParse(leadIds);
  if (!parsed.success) return { ok: false, error: fill(FE.tooMany, { n: FIND_MAX_LEADS }) };
  const db = await createClient();
  if (!db) return { ok: false, error: FE.failed };
  try {
    const [items, fields] = await Promise.all([
      listLeads(db, workspace.id, { ids: parsed.data }),
      inLeadChunks<LeadFieldRow>(
        parsed.data,
        (c) => db.from("lead_fields").select(LEAD_FIELD_COLUMNS).eq("workspace_id", workspace.id).in("lead_id", c).in("field", ["email", "contact_name", "website"]) as never,
        "findEmail fields",
      ),
    ]);
    const verifier = emailVerifier();
    const results = await findEmails(
      items.map((i) => ({ item: i, fields: fields.filter((f) => f.lead_id === i.lead.id) })),
      {
        lookup: systemLookup(),
        verifier,
        addGuesses: async (rows) => {
          const { error } = await db.from("lead_fields").insert(rows.map((r) => ({ workspace_id: workspace.id, lead_id: r.leadId, field: "email", value: r.email, source: "pattern", source_ref: r.pattern, status: "unverified", excerpt: r.excerpt })));
          if (error && error.code !== "23505") throw new Error(`addGuesses: ${error.message}`);
        },
        saveVerdict: async (email, status) => {
          const { error } = await db.from("email_checks").upsert({ workspace_id: workspace.id, email, status, method: "verifier", detail: verifier?.name ?? null }, { onConflict: "workspace_id,email" });
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
