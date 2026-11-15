import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { TestDb, as, setSchedulerToken, tryCommit } from "./helpers";
import { TOKEN } from "./scheduler-seed";
import { beginQualifierTick, qclock, seedQualifierLead } from "./qualifier-seed";

// Migration 0019: a claimed lead is re-opened only by data or a manual request that really came after its claim, and a
// re-open caused by data never repeats the paid deep step. Every case pins the timestamps, so none depends on the clock.

let db: TestDb;
const rpc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(qclock, sql, params);
const claim = async (tick: string) =>
  (await rpc<{ r: { lead_id: string; deep_requested: boolean; manual: boolean } | null }>("select public.qualifier_claim_next($1) as r", [tick]))[0].r;
const finishDeep = (tick: string, lead: string) =>
  tryCommit(db, qclock, "select public.qualifier_step_done($1,$2,'p5','ok','done','complete')", [tick, lead]);
const queue = async (lead: string) =>
  (
    await db.admin<{ next_step: string; done_reason: string | null; manual: boolean; deep: boolean }>(
      "select next_step, done_reason, manual_at is not null as manual, deep_requested as deep from public.qualifier_queue where lead_id = $1",
      [lead],
    )
  )[0];
const importField = (ws: string, lead: string, ref: string) =>
  db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref) values ($1,$2,'email','late@acme.example','import',$3)", [ws, lead, ref]);

beforeAll(async () => {
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
afterEach(async () => {
  await db.admin("update public.qualifier_ticks set finished_at = now() where finished_at is null");
  await db.admin("delete from public.leads");
});
afterAll(async () => {
  await db.pg.close();
});

describe("0019 qualifier re-queue", () => {
  test("a field inserted before the claim but stamped with the claim's own instant does not re-open the lead", async () => {
    const { lead } = await seedQualifierLead(db, { fields: [{ field: "phone", value: "5085550177" }] });
    await db.admin("update public.qualifier_queue set manual_at = now() - interval '1 minute', deep_requested = true where lead_id = $1", [lead]);
    const tick = await beginQualifierTick(db);
    expect((await claim(tick))!.lead_id).toBe(lead);
    // the tie: same timestamp as the claim (coarse clock, or one transaction)
    await db.admin("update public.lead_fields set created_at = (select claimed_at from public.qualifier_queue where lead_id = $1) where lead_id = $1", [lead]);
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect(await queue(lead)).toEqual({ next_step: "done", done_reason: "complete", manual: false, deep: false });
  });

  test("a field stamped ahead of the clock but inserted before the claim does not re-open the lead", async () => {
    const { lead } = await seedQualifierLead(db, { fields: [{ field: "phone", value: "5085550178" }] });
    await db.admin("update public.lead_fields set created_at = now() + interval '1 hour' where lead_id = $1", [lead]);
    const tick = await beginQualifierTick(db);
    expect((await claim(tick))!.lead_id).toBe(lead);
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect((await queue(lead)).next_step).toBe("done");
  });

  test("a field that really arrives during a manual deep claim re-opens the lead for the cheap steps, without the paid deep step", async () => {
    const { ws, lead } = await seedQualifierLead(db, { fields: [{ field: "phone", value: "5085550179" }] });
    await db.admin("update public.qualifier_queue set manual_at = now() - interval '1 minute', deep_requested = true where lead_id = $1", [lead]);
    const tick = await beginQualifierTick(db);
    const s = (await claim(tick))!;
    expect(s).toMatchObject({ lead_id: lead, deep_requested: true, manual: true });
    await importField(ws, lead, "late-list");
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect(await queue(lead)).toEqual({ next_step: "p1", done_reason: null, manual: false, deep: false });
    // the next claim runs the free steps again, with no deep request
    await db.admin("update public.qualifier_queue set locked_until = null where lead_id = $1", [lead]);
    expect(await claim(tick)).toMatchObject({ lead_id: lead, deep_requested: false, manual: false });
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect((await queue(lead)).next_step).toBe("done");
  });

  test("a field that arrives after the claim with a timestamp from the past still re-opens the lead: the order of events decides, not the clock", async () => {
    const { ws, lead } = await seedQualifierLead(db);
    const tick = await beginQualifierTick(db);
    expect((await claim(tick))!.lead_id).toBe(lead);
    await importField(ws, lead, "late-list-old-stamp");
    await db.admin("update public.lead_fields set created_at = now() - interval '1 day' where lead_id = $1", [lead]);
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect((await queue(lead)).next_step).toBe("p1");
  });

  test("a new manual request made during the claim keeps its deep step, even stamped at the claim's instant", async () => {
    const { ws, owner, lead } = await seedQualifierLead(db, { fields: [{ field: "phone", value: "5085550180" }] });
    // the seeded field is old, so only the request can re-open the lead
    await db.admin("update public.lead_fields set created_at = now() - interval '1 day' where lead_id = $1", [lead]);
    const tick = await beginQualifierTick(db);
    expect((await claim(tick))!.lead_id).toBe(lead);
    await db.query(as(owner), "select public.request_qualification($1,$2::uuid[])", [ws, `{${lead}}`]);
    await db.admin("update public.qualifier_queue set manual_at = claimed_at where lead_id = $1", [lead]);
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect(await queue(lead)).toEqual({ next_step: "p1", done_reason: null, manual: true, deep: true });
    // claimed again: that request is now older than the claim, so finishing closes the lead and clears it
    await db.admin("update public.qualifier_queue set locked_until = null where lead_id = $1", [lead]);
    expect(await claim(tick)).toMatchObject({ lead_id: lead, deep_requested: true, manual: true });
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect(await queue(lead)).toEqual({ next_step: "done", done_reason: "complete", manual: false, deep: false });
  });

  test("data and a manual request both during the claim: the request wins and keeps its deep step", async () => {
    const { ws, owner, lead } = await seedQualifierLead(db);
    const tick = await beginQualifierTick(db);
    expect((await claim(tick))!.lead_id).toBe(lead);
    await importField(ws, lead, "late-list-2");
    await db.query(as(owner), "select public.request_qualification($1,$2::uuid[])", [ws, `{${lead}}`]);
    expect((await finishDeep(tick, lead)).error).toBeUndefined();
    expect(await queue(lead)).toEqual({ next_step: "p1", done_reason: null, manual: true, deep: true });
  });
});
