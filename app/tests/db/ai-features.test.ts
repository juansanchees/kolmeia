import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATION_PATHS, TestDb, anon, as, UUID_B, UUID_C } from "./helpers";
import { createOwner, seedCampaign } from "./scheduler-seed";

// Migration 0029 (Fase 3): AI questions/answers RLS, the evidence rule, the draft signal and the strong redraft RPC.
let db: TestDb;
let ws: string;
let wsB: string;
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOSER = UUID_C;
let question: string;
let mine: string;
let other: string;

const newLead = async (w = ws) => (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [w]))[0].id;

beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db, OWNER);
  wsB = await createOwner(db, UUID_B);
  await db.addUser(CLOSER);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [ws, CLOSER]);
  question = (
    await db.query<{ id: string }>(as(OWNER), "insert into public.ai_questions (workspace_id, question, answer_type, sources) values ($1,'Faz obra multifamiliar?','yes_no_unknown','{site,data}') returning id", [ws])
  )[0].id;
  mine = await newLead();
  other = await newLead();
  // the hand-off assigns the lead to the closer (leads.owner_id, 0020)
  await db.admin("update public.leads set owner_id = $1, handed_off_at = now() where id = $2", [CLOSER, mine]);
  for (const lead of [mine, other]) {
    await db.query(as(OWNER), "insert into public.ai_answers (workspace_id, question_id, lead_id) values ($1,$2,$3)", [ws, question, lead]);
  }
});
afterAll(async () => {
  await db.pg.close();
});

const setDone = (lead: string, answer: string, excerpt: string | null) =>
  db.try(as(OWNER), "update public.ai_answers set status = 'done', answer = $1, evidence_excerpt = $2 where question_id = $3 and lead_id = $4", [answer, excerpt, question, lead]);

describe("0029 ai_questions / ai_answers", () => {
  test("only owner/sdr create questions; the closer cannot; anon reads nothing", async () => {
    expect((await db.try(as(CLOSER), "insert into public.ai_questions (workspace_id, question, answer_type, sources) values ($1,'x?','short_text','{data}')", [ws])).error).toBeDefined();
    expect((await db.try(as(OWNER), "insert into public.ai_questions (workspace_id, question, answer_type, sources) values ($1,'Pergunta?','short_text','{web}')", [ws])).error).toBeDefined();
    expect((await db.try(as(OWNER), "insert into public.ai_questions (workspace_id, question, answer_type, sources) values ($1,$2,'short_text','{data}')", [ws, "x".repeat(301)])).error).toBeDefined();
    expect((await db.try(anon, "select * from public.ai_questions")).error).toBeDefined();
    expect((await db.try(anon, "select * from public.ai_answers")).error).toBeDefined();
    // another workspace's owner sees none of it
    expect(await db.query(as(UUID_B), "select id from public.ai_questions")).toEqual([]);
    expect(await db.query(as(UUID_B), "select id from public.ai_answers")).toEqual([]);
  });

  test("a finished answer other than 'unknown' needs its evidence excerpt; 'unknown' needs none", async () => {
    expect((await setDone(other, "yes", null)).error?.message).toMatch(/ai_answers_evidence/);
    expect((await setDone(other, "unknown", null)).error).toBeUndefined();
    expect((await setDone(other, "yes", "…multi-family developments…")).error).toBeUndefined();
  });

  test("the closer reads only the answers of leads handed to her, and writes none", async () => {
    await db.query(as(OWNER), "update public.ai_answers set status = 'done', answer = 'yes', evidence_excerpt = 'we build condos' where question_id = $1", [question]);
    const seen = await db.query<{ lead_id: string }>(as(CLOSER), "select lead_id from public.ai_answers");
    expect(seen.map((r) => r.lead_id)).toEqual([mine]);
    const upd = await db.run(as(CLOSER), (q) => q("update public.ai_answers set answer = 'no' where lead_id = $1 returning id", [mine]));
    expect(upd).toEqual([]);
    expect((await db.try(as(CLOSER), "insert into public.ai_answers (workspace_id, question_id, lead_id) values ($1,$2,$3)", [ws, question, await newLead()])).error).toBeDefined();
  });

  test("a sender cannot queue a lead or question of another workspace, nor a finished row directly", async () => {
    const foreign = await newLead(wsB);
    expect((await db.try(as(OWNER), "insert into public.ai_answers (workspace_id, question_id, lead_id) values ($1,$2,$3)", [ws, question, foreign])).error).toBeDefined();
    expect((await db.try(as(UUID_B), "insert into public.ai_answers (workspace_id, question_id, lead_id) values ($1,$2,$3)", [wsB, question, foreign])).error).toBeDefined();
    const lead = await newLead();
    expect((await db.try(as(OWNER), "insert into public.ai_answers (workspace_id, question_id, lead_id, status) values ($1,$2,$3,'done')", [ws, question, lead])).error).toBeDefined();
  });

  test("question text is frozen once created; archiving works", async () => {
    await db.query(as(OWNER), "update public.ai_questions set archived_at = now() where id = $1", [question]);
    const row = (await db.admin<{ question: string; archived_at: string | null }>("select question, archived_at from public.ai_questions where id = $1", [question]))[0];
    expect(row.question).toBe("Faz obra multifamiliar?");
    expect(row.archived_at).not.toBeNull();
    // an archived question takes no new leads
    expect((await db.try(as(OWNER), "insert into public.ai_answers (workspace_id, question_id, lead_id) values ($1,$2,$3)", [ws, question, await newLead()])).error).toBeDefined();
  });

  test("the migration is re-runnable", async () => {
    const file = MIGRATION_PATHS.find((p) => p.endsWith("0029_ai_features.sql"))!;
    await db.pg.exec(readFileSync(file, "utf8"));
    expect((await db.admin<{ n: number }>("select count(*)::int as n from public.ai_answers"))[0].n).toBeGreaterThan(0);
  });

  test("the ledger accepts the new AI tasks", async () => {
    for (const task of ["ai_answer", "lead_explain"]) {
      await db.admin(
        "insert into public.ai_calls (workspace_id, task, model, prompt_version, status) values ($1,$2,'claude-haiku-5-5','v1','ok')",
        [ws, task],
      );
    }
    expect((await db.try(as(OWNER), "select 1")).error).toBeUndefined();
  });
});

describe("0029 e-mail: signal and strong redraft", () => {
  test("replace_ai_draft swaps a draft's text as a new AI version (not a human edit), only at the version the person saw", async () => {
    const s = await seedCampaign(db, ws, "redraft", { approve: false });
    const [msg] = s.messages;
    const v = (await db.admin<{ updated_at: string }>("select updated_at from public.email_messages where id = $1", [msg]))[0].updated_at;
    const call = (who: string, version: string) =>
      db.query<{ ok: boolean }>(as(who), "select public.replace_ai_draft($1,$2,'your 4-unit permit','Hi Pat, saw the permit. Who handles HVAC?','claude-sonnet-5-5','email-draft-x','[\"alvará\"]'::jsonb,false,'Alvará · 12 Elm St') as ok", [msg, version]);
    expect((await db.try(as(CLOSER), "select public.replace_ai_draft($1,$2,'s','b','m','p','[]'::jsonb,false,null)", [msg, v])).error).toBeDefined();
    expect((await call(OWNER, "2000-01-01T00:00:00Z"))[0].ok).toBe(false);
    expect((await call(OWNER, v))[0].ok).toBe(true);
    const row = (await db.admin<Record<string, unknown>>("select subject, ai_drafted, ai_model, human_edited, ai_signal, status from public.email_messages where id = $1", [msg]))[0];
    expect(row).toMatchObject({ subject: "your 4-unit permit", ai_drafted: true, ai_model: "claude-sonnet-5-5", human_edited: false, ai_signal: "Alvará · 12 Elm St", status: "draft" });
    // a link is still refused (R12 table check)
    const v2 = (await db.admin<{ updated_at: string }>("select updated_at from public.email_messages where id = $1", [msg]))[0].updated_at;
    expect((await db.try(as(OWNER), "select public.replace_ai_draft($1,$2,'s','see https://x.example','m','p','[]'::jsonb,false,null)", [msg, v2])).error).toBeDefined();
  });

  test("an approved step is never replaced", async () => {
    const s = await seedCampaign(db, ws, "approved", { approve: true });
    const [msg] = s.messages;
    const v = (await db.admin<{ updated_at: string }>("select updated_at from public.email_messages where id = $1", [msg]))[0].updated_at;
    const r = await db.query<{ ok: boolean }>(as(OWNER), "select public.replace_ai_draft($1,$2,'s','b','m','p','[]'::jsonb,false,null) as ok", [msg, v]);
    expect(r[0].ok).toBe(false);
  });

  test("a sender may store the signal with a new draft", async () => {
    const s = await seedCampaign(db, ws, "signal", { approve: false });
    await db.query(
      as(OWNER),
      "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted, ai_signal) values ($1,$2,$3,'sequence',2,'Following up','Hi Pat, any news?',true,'Alvará · 12 Elm St')",
      [ws, s.campaign, s.prospects[0]],
    );
    const r = await db.admin<{ ai_signal: string }>("select ai_signal from public.email_messages where prospect_id = $1 and step = 2", [s.prospects[0]]);
    expect(r[0].ai_signal).toBe("Alvará · 12 Elm St");
  });
});

describe("0029 claims and re-queues (review fixes)", () => {
  test("two steps claiming the same queued row: only one gets it", async () => {
    const q2 = (await db.query<{ id: string }>(as(OWNER), "insert into public.ai_questions (workspace_id, question, answer_type, sources) values ($1,'Faz prédio?','yes_no_unknown','{data}') returning id", [ws]))[0].id;
    const lead = await newLead();
    const row = (await db.query<{ id: string }>(as(OWNER), "insert into public.ai_answers (workspace_id, question_id, lead_id) values ($1,$2,$3) returning id", [ws, q2, lead]))[0].id;
    // what SupabaseAnswerStore.claim sends: a conditional update that only takes a free queued row
    const claim = () =>
      db.query(as(OWNER), "update public.ai_answers set claimed_at = now() where id = $1 and status = 'queued' and (claimed_at is null or claimed_at < now() - interval '10 minutes') returning id", [row]);
    // both tabs saw the row free; their updates run one after the other in the database
    const [a, b] = [await claim(), await claim()];
    expect([a.length, b.length]).toEqual([1, 0]);
  });

  test("a re-queued row keeps its paid answer and evidence, and can go back to done unchanged", async () => {
    const q3 = (await db.query<{ id: string }>(as(OWNER), "insert into public.ai_questions (workspace_id, question, answer_type, sources) values ($1,'Faz condomínio?','yes_no_unknown','{data}') returning id", [ws]))[0].id;
    const lead = await newLead();
    await db.query(as(OWNER), "insert into public.ai_answers (workspace_id, question_id, lead_id) values ($1,$2,$3)", [ws, q3, lead]);
    await db.query(as(OWNER), "update public.ai_answers set status = 'done', answer = 'yes', evidence_excerpt = 'we build condos' where question_id = $1", [q3]);
    await db.query(as(OWNER), "update public.ai_answers set status = 'queued', error = null, claimed_at = null where question_id = $1", [q3]);
    await db.query(as(OWNER), "update public.ai_answers set status = 'done' where question_id = $1 and status = 'queued' and claimed_at is null and answer is not null", [q3]);
    const r = await db.admin<{ status: string; answer: string; evidence_excerpt: string }>("select status, answer, evidence_excerpt from public.ai_answers where question_id = $1", [q3]);
    expect(r).toEqual([{ status: "done", answer: "yes", evidence_excerpt: "we build condos" }]);
  });
});
