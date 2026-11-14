import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { rpcQualifierStore } from "@/lib/qualifier/store";
import { runQualifierTick } from "@/lib/qualifier/tick";
import { TestDb, setSchedulerToken } from "../db/helpers";
import { TOKEN } from "../db/scheduler-seed";
import { seedQualifierLead } from "../db/qualifier-seed";
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
