import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { rpcQualifierStore } from "@/lib/qualifier/store";
import { runQualifierTick } from "@/lib/qualifier/tick";
import { TestDb, setSchedulerToken } from "../db/helpers";
import { TOKEN } from "../db/scheduler-seed";
import { seedQualifierLead } from "../db/qualifier-seed";
import { FakeTransport } from "./fake-ai";
import { fakeHttp, htmlPage } from "../unit/qualifier-fakes";
import { pgRpc } from "./pg-rpc";

// F3c-2 Task 4 over PGlite: the real tick, the real 0014 functions, a fake network, no AI.
let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
afterAll(async () => {
  await db.pg.close();
});

const SITE = "https://acme-hvac.test/";
const PAGE = htmlPage(
  `<script type="application/ld+json">{"@type":"HVACBusiness","name":"Acme HVAC","telephone":"+1 508-555-0142","address":{"@type":"PostalAddress","streetAddress":"12 Main Street","addressLocality":"Worcester","addressRegion":"MA"}}</script><a href="mailto:hello@acme-hvac.test">Mail</a>`,
);

describe("Qualificador tick on the real path", () => {
  test("a full free pass on the real path: an imported lead with a site reaches level 2 with the site's proof and no ai_calls row", async () => {
    const { ws, lead } = await seedQualifierLead(db, { fields: [{ field: "website", value: SITE }, { field: "name", value: "Acme HVAC" }] });
    const http = fakeHttp({ [SITE]: PAGE });
    const run = () => runQualifierTick({ store: rpcQualifierStore(pgRpc(db, TOKEN)), transport: null, http, sleep: async () => undefined });
    // the lead is claimed at p1 (nothing to merge), then runs to the end in one pass
    const r = await run();
    expect(r).toMatchObject({ outcome: "ok", failed: 0 });
    expect(r.leads).toBeGreaterThanOrEqual(1);
    const [l] = await db.admin<{ level: number }>("select level from public.leads where id = $1", [lead]);
    expect(l.level).toBe(2);
    const proof = await db.admin<{ field: string; source: string; status: string; source_ref: string; excerpt: string }>(
      "select field, source, status, source_ref, excerpt from public.lead_fields where lead_id = $1 and source = 'site' order by field",
      [lead],
    );
    expect(proof.map((p) => p.field)).toEqual(expect.arrayContaining(["address", "email", "phone", "website"]));
    expect(proof.every((p) => p.status === "confirmed" && p.source_ref === SITE)).toBe(true);
    const q = await db.admin<{ next_step: string; done_reason: string; locked_by: string | null }>("select next_step, done_reason, locked_by from public.qualifier_queue where lead_id = $1", [lead]);
    expect(q[0]).toEqual({ next_step: "done", done_reason: "complete", locked_by: null });
    const calls = await db.admin("select 1 from public.ai_calls where workspace_id = $1", [ws]);
    expect(calls).toHaveLength(0);
    // nothing is claimable any more and the heartbeat is closed
    expect((await run()).leads).toBe(0);
    const ticks = await db.admin("select 1 from public.qualifier_ticks where finished_at is null");
    expect(ticks).toHaveLength(0);
  });
});

const ABOUT = "https://beta-mechanical.test/about";
/** The fake qualify_deep answer: Beta Mechanical exists and its owner is named on its about page. */
const deepAnswer = () => ({
    companies: [
      {
        ref: "L1",
        urls_tried: [],
        checks: [
          { kind: "exists_active", result: "ok", summary: "ativa", evidence: [{ url: ABOUT, title: "About", excerpt: "Beta Mechanical, est. 2004" }] },
          { kind: "has_work", result: "unknown", summary: "", evidence: [] },
          { kind: "decision_maker", result: "ok", summary: "dono", evidence: [{ url: ABOUT, title: "About", excerpt: "Lee Beta, Owner" }] },
        ],
        permit_count: "", total_value_usd: "", last_permit_date: "", biggest_job_address: "", biggest_job_value_usd: "", biggest_job_type: "", biggest_job_description: "", signal_match: "",
        ask_for_name: "Lee Beta", ask_for_title: "Owner", name_confidence: "medium", name_source_url: ABOUT, name_note: "",
        phone: "", phone_source_url: "", website: "", public_email: "", email_type: "none", email_source_url: "", google_rating: "", review_count: "", rating_source_url: "",
        is_large_contractor: false, supplier_portal_url: "", hook: "", notes: "",
      },
    ],
    jobs_without_builder: [],
  });

describe("Qualificador deep step on the real path", () => {
  test("with a fake AI, a manual request reaches level 3 with proof; its ai_calls rows carry lead_id and qualify_deep; the queue's spent equals the ledger", async () => {
    const { ws, lead } = await seedQualifierLead(db, { fields: [{ field: "phone", value: "5085550177" }, { field: "name", value: "Beta Mechanical" }] });
    // what the lead page's "qualificar" button does (request_qualification, as a sender): manual, strong AI step on
    await db.admin("update public.qualifier_queue set manual_at = now(), deep_requested = true where lead_id = $1", [lead]);
    // deterministic: the imported values carry a stamp at or after the coming claim (a coarse clock gives a tie); they
    // were inserted before the claim, so they must not re-open the lead and pay for the deep step twice
    await db.admin("update public.lead_fields set created_at = now() + interval '1 hour' where lead_id = $1", [lead]);
    const ai = new FakeTransport({
      qualify_deep: () => ({ json: deepAnswer() }),
    });
    const r = await runQualifierTick({ store: rpcQualifierStore(pgRpc(db, TOKEN)), transport: ai, http: fakeHttp({}), sleep: async () => undefined });
    expect(r).toMatchObject({ outcome: "ok", failed: 0 });
    expect(ai.callsFor("qualify_deep")).toHaveLength(1);
    const [l] = await db.admin<{ level: number }>("select level from public.leads where id = $1", [lead]);
    expect(l.level).toBe(3);
    const proof = await db.admin<{ field: string; status: string; source: string; source_ref: string; excerpt: string }>(
      "select field, status, source, source_ref, excerpt from public.lead_fields where lead_id = $1 and source = 'ai' order by field",
      [lead],
    );
    expect(proof).toEqual([
      { field: "contact_name", status: "confirmed", source: "ai", source_ref: ABOUT, excerpt: "Lee Beta, Owner" },
      { field: "contact_title", status: "confirmed", source: "ai", source_ref: ABOUT, excerpt: "Lee Beta, Owner" },
    ]);
    const calls = await db.admin<{ lead_id: string; task: string; status: string; cost_usd: string }>("select lead_id, task, status, cost_usd from public.ai_calls where workspace_id = $1", [ws]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ lead_id: lead, task: "qualify_deep", status: "ok" });
    const [q] = await db.admin<{ spent_usd: string; next_step: string; done_reason: string }>("select spent_usd, next_step, done_reason from public.qualifier_queue where lead_id = $1", [lead]);
    expect(Number(q.spent_usd)).toBeCloseTo(Number(calls[0].cost_usd), 6);
    expect(Number(q.spent_usd)).toBeGreaterThan(0);
    expect(q).toMatchObject({ next_step: "done", done_reason: "complete" });
  });

  test("a value imported while the deep step runs re-opens the lead for the free steps, but the paid deep step runs once", async () => {
    const { ws, lead } = await seedQualifierLead(db, { fields: [{ field: "phone", value: "5085550178" }, { field: "name", value: "Beta Mechanical" }] });
    await db.admin("update public.qualifier_queue set manual_at = now(), deep_requested = true where lead_id = $1", [lead]);
    let arrival: Promise<unknown> | null = null;
    const ai = new FakeTransport({
      qualify_deep: () => {
        // an import lands mid-call (queued on the same database before the step is recorded)
        arrival ??= db.admin(
          "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref) values ($1,$2,'email','office@beta-mechanical.test','import','late-list')",
          [ws, lead],
        );
        return { json: deepAnswer() };
      },
    });
    const r = await runQualifierTick({ store: rpcQualifierStore(pgRpc(db, TOKEN)), transport: ai, http: fakeHttp({}), sleep: async () => undefined });
    await arrival;
    expect(r).toMatchObject({ outcome: "ok", failed: 0 });
    expect(ai.callsFor("qualify_deep")).toHaveLength(1);
    const p1 = await db.admin("select 1 from public.qualifier_step_log where lead_id = $1 and step = 'p1'", [lead]);
    expect(p1).toHaveLength(2);
    const [q] = await db.admin<{ next_step: string; done_reason: string; manual: boolean; deep: boolean }>(
      "select next_step, done_reason, manual_at is not null as manual, deep_requested as deep from public.qualifier_queue where lead_id = $1",
      [lead],
    );
    expect(q).toEqual({ next_step: "done", done_reason: "complete", manual: false, deep: false });
    const calls = await db.admin("select 1 from public.ai_calls where lead_id = $1 and task = 'qualify_deep'", [lead]);
    expect(calls).toHaveLength(1);
  });

  test("a contact e-mail for a finished lead resumes at p5: no second site read, no second P4 charge, and the deep step runs when eligible", async () => {
    // the site shows a phone but no e-mail and no address: P2 would read it again on a full pass
    const site = "https://gamma-hvac.test/";
    const page = htmlPage(`<h1>Gamma HVAC</h1><p>Call <a href="tel:+15085550143">508-555-0143</a></p>`);
    const { ws, lead } = await seedQualifierLead(db, { fields: [{ field: "website", value: site }, { field: "name", value: "Gamma HVAC" }] });
    const ai = new FakeTransport({
      qualify_light: () => ({ json: { company_type: "builder", city: "", state: "", size_note: "", address: "", contacts: [] } }),
      qualify_deep: () => ({ json: deepAnswer() }),
    });
    // what each claim handed the cascade
    const store = rpcQualifierStore(pgRpc(db, TOKEN));
    const claimNext = store.claimNext.bind(store);
    const claims: Awaited<ReturnType<typeof claimNext>>[] = [];
    store.claimNext = async (tick) => {
      const l = await claimNext(tick);
      if (l) claims.push(l);
      return l;
    };
    const run = () => runQualifierTick({ store, transport: ai, http: fakeHttp({ [site]: page }), sleep: async () => undefined });
    expect(await run()).toMatchObject({ outcome: "ok", failed: 0 });
    const tasks = async () => (await db.admin<{ task: string }>("select task from public.ai_calls where lead_id = $1 order by created_at, id", [lead])).map((c) => c.task);
    expect(await tasks()).toEqual(["qualify_light"]);
    // the contact scraper answers later (P2b), and the lead now matches the profile with auto deep on
    await db.admin(
      "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status) values ($1,$2,'email','office@gamma-hvac.test','apify_contact','https://gamma-hvac.test/contact','confirmed')",
      [ws, lead],
    );
    await db.admin("update public.qualifier_queue set profile_match = true where lead_id = $1", [lead]);
    expect(await run()).toMatchObject({ outcome: "ok", failed: 0 });
    expect(await tasks()).toEqual(["qualify_light", "qualify_deep"]);
    // the p5 resume was handed the new e-mail with the lead's values
    expect(claims.at(-1)).toMatchObject({ nextStep: "p5" });
    expect(claims.at(-1)!.fields.some((f) => f.source === "apify_contact" && f.value === "office@gamma-hvac.test")).toBe(true);
    const steps = await db.admin<{ step: string }>("select step from public.qualifier_step_log where lead_id = $1 and step in ('p2', 'p4')", [lead]);
    expect(steps.map((x) => x.step).sort()).toEqual(["p2", "p4"]);
    const [q2] = await db.admin<{ next_step: string; done_reason: string }>("select next_step, done_reason from public.qualifier_queue where lead_id = $1", [lead]);
    expect(q2).toEqual({ next_step: "done", done_reason: "complete" });
  });
});
