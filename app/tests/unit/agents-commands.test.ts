import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archiveAgent, finishHunter, pauseHunter, startHunter, turnOnHunter, type Actor } from "@/lib/agents/commands";
import type { AgentStore } from "@/lib/agents/store";
import type { AgentPatch, AgentRow, AgentStatus } from "@/lib/agents/types";
import type { HunterSetup } from "@/lib/agents/hunter";
import type { NewRun, ResearchStore } from "@/lib/research/store";
import type { RunRow } from "@/lib/research/rows";
import { DEFAULT_CAPS } from "@/lib/research/types";
import { hunterConfig, hunterSetupSchema } from "@/lib/agents/hunter";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

class FakeAgentStore implements AgentStore {
  agents = new Map<string, AgentRow>();
  patches: [string, AgentPatch][] = [];
  async insertDraft(a: { workspaceId: string; name: string; config: HunterSetup }) {
    const id = `agent-${this.agents.size + 1}`;
    this.agents.set(id, {
      id,
      workspace_id: a.workspaceId,
      type: "hunter",
      name: a.name,
      status: "draft",
      config: a.config,
      schedule: "weekly",
      next_run_at: null,
      paused_reason: null,
      archived_at: null,
      created_at: "2026-11-14T00:00:00Z",
      updated_at: "2026-11-14T00:00:00Z",
    });
    return id;
  }
  async getAgent(id: string) {
    return this.agents.get(id) ?? null;
  }
  async updateAgent(id: string, patch: AgentPatch) {
    this.patches.push([id, patch]);
  }
  ifCalls: [string, AgentStatus][] = [];
  /** Mirrors the A7 trigger: a 4th running hunter is refused. */
  async updateAgentIf(id: string, expected: AgentStatus, patch: AgentPatch) {
    this.ifCalls.push([id, expected]);
    const a = this.agents.get(id);
    if (!a || a.status !== expected) return false;
    if (patch.status === "running" && [...this.agents.values()].filter((x) => x.status === "running").length >= 3) {
      throw new Error("A7: no more than 3 running hunters");
    }
    this.patches.push([id, patch]);
    if (patch.status) a.status = patch.status;
    return true;
  }
  runs: RunRow[] = [];
  async listRuns() {
    return this.runs;
  }
  async listAgents() {
    return [...this.agents.values()];
  }
  setupRun: RunRow | null = null;
  async getSetupRun() {
    return this.setupRun;
  }
}

function fakeResearch(opts: { fail?: boolean } = {}) {
  const runs: NewRun[] = [];
  const store = {
    async createRun(r: NewRun) {
      if (opts.fail) throw new Error("boom");
      runs.push(r);
      return "run-1";
    },
  } as unknown as ResearchStore;
  return { store, runs };
}

const owner: Actor = { workspaceId: "w1", role: "owner" };
const good = { profileSource: "saved", companyNote: "", audience: "builder", audienceText: "", region: "Boston" };

describe("F2 agent commands", () => {
  test("startHunter: bad answers create nothing and say which field", async () => {
    const agents = new FakeAgentStore();
    const r = fakeResearch();
    const res = await startHunter(agents, r.store, owner, { ...good, region: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("invalid");
      expect(res.fieldErrors?.region).toBeTruthy();
    }
    expect(agents.agents.size).toBe(0);
    expect(r.runs).toHaveLength(0);
  });

  test("startHunter: the closer is refused and nothing is created", async () => {
    const agents = new FakeAgentStore();
    const r = fakeResearch();
    const res = await startHunter(agents, r.store, { workspaceId: "w1", role: "closer" }, good);
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(agents.agents.size).toBe(0);
    expect(r.runs).toHaveLength(0);
  });

  test("startHunter: creates a draft hunter and its setup research", async () => {
    const agents = new FakeAgentStore();
    const r = fakeResearch();
    const res = await startHunter(agents, r.store, owner, good);
    expect(res.ok).toBe(true);
    expect(agents.agents.size).toBe(1);
    const [id, a] = [...agents.agents.entries()][0];
    expect(res.ok && res.agentId).toBe(id);
    expect(a.name).toBe("Caçador Construtores Boston");
    expect(a.config).toEqual(good);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({
      workspaceId: "w1",
      requestText: "Achar construtores",
      regionText: "Boston",
      rigor: "careful",
      ...DEFAULT_CAPS.careful,
      setupAgentId: id,
    });
  });

  test("startHunter: a failing setup run leaves the draft and says generic", async () => {
    const agents = new FakeAgentStore();
    const res = await startHunter(agents, fakeResearch({ fail: true }).store, owner, good);
    expect(res).toEqual({ ok: false, error: "generic" });
    expect(agents.agents.size).toBe(1);
  });

  test("archiveAgent: archives an agent of the workspace; the closer and other workspaces are refused", async () => {
    const agents = new FakeAgentStore();
    const id = await agents.insertDraft({ workspaceId: "w1", name: "x", config: good as HunterSetup });
    expect(await archiveAgent(agents, owner, id)).toEqual({ ok: true });
    expect(agents.patches).toHaveLength(1);
    expect(typeof agents.patches[0][1].archived_at).toBe("string");
    expect(await archiveAgent(agents, { workspaceId: "w1", role: "closer" }, id)).toEqual({ ok: false, error: "forbidden" });
    expect(await archiveAgent(agents, { workspaceId: "w2", role: "owner" }, id)).toEqual({ ok: false, error: "not_found" });
    expect(await archiveAgent(agents, owner, "missing")).toEqual({ ok: false, error: "not_found" });
    expect(agents.patches).toHaveLength(1);
  });

  test("the one-off research list hides agent setup runs", () => {
    for (const f of ["src/app/(app)/agentes/page.tsx", "src/app/(app)/agentes/pesquisa/layout.tsx"]) {
      expect(read(f), f).toContain('.is("setup_agent_id", null)');
    }
  });

  describe("F3b life cycle", () => {
    const closer: Actor = { workspaceId: "w1", role: "closer" };
    async function agentWith(agents: FakeAgentStore, status: AgentStatus) {
      const id = await agents.insertDraft({ workspaceId: "w1", name: "x", config: good as HunterSetup });
      agents.agents.get(id)!.status = status;
      return id;
    }

    test("turnOnHunter: paused becomes running; the 4th comes back as too_many; the closer is refused", async () => {
      const agents = new FakeAgentStore();
      const id = await agentWith(agents, "paused");
      expect(await turnOnHunter(agents, owner, id)).toEqual({ ok: true });
      expect(agents.agents.get(id)!.status).toBe("running");
      expect(agents.patches).toEqual([[id, { status: "running" }]]);
      // already running: ok, no write
      expect(await turnOnHunter(agents, owner, id)).toEqual({ ok: true });
      expect(agents.patches).toHaveLength(1);
      // draft: not ready
      const d = await agentWith(agents, "draft");
      expect(await turnOnHunter(agents, owner, d)).toEqual({ ok: false, error: "not_ready" });
      expect(await turnOnHunter(agents, closer, id)).toEqual({ ok: false, error: "forbidden" });
      expect(await turnOnHunter(agents, { workspaceId: "w2", role: "owner" }, id)).toEqual({ ok: false, error: "not_found" });
      // fill to 3 running, the 4th is refused
      await turnOnHunter(agents, owner, await agentWith(agents, "paused"));
      await turnOnHunter(agents, owner, await agentWith(agents, "paused"));
      const fourth = await agentWith(agents, "paused");
      expect(await turnOnHunter(agents, owner, fourth)).toEqual({ ok: false, error: "too_many" });
      expect(agents.agents.get(fourth)!.status).toBe("paused");
    });

    test("pauseHunter: running becomes paused and its running research is paused by the user", async () => {
      const agents = new FakeAgentStore();
      const id = await agentWith(agents, "running");
      agents.runs = [{ id: "run-9", status: "running", progress: {} } as unknown as RunRow];
      const updates: [string, unknown][] = [];
      const research = { async updateRun(runId: string, patch: unknown) { updates.push([runId, patch]); } } as unknown as ResearchStore;
      expect(await pauseHunter(agents, research, owner, id)).toEqual({ ok: true });
      expect(agents.agents.get(id)!.status).toBe("paused");
      expect(updates).toEqual([["run-9", { status: "paused", progress: { pauseReason: "user" } }]]);
      expect(await pauseHunter(agents, research, closer, id)).toEqual({ ok: false, error: "forbidden" });
      // not running any more (second tab): nothing else is touched
      expect(await pauseHunter(agents, research, owner, id)).toEqual({ ok: true });
      expect(updates).toHaveLength(1);
    });

    test('archiveAgent: a running agent is refused with "running"; draft, paused and done archive', async () => {
      const agents = new FakeAgentStore();
      const run = await agentWith(agents, "running");
      expect(await archiveAgent(agents, owner, run)).toEqual({ ok: false, error: "running" });
      expect(agents.patches).toHaveLength(0);
      for (const st of ["draft", "paused", "done"] as const) {
        const id = await agentWith(agents, st);
        expect(await archiveAgent(agents, owner, id)).toEqual({ ok: true });
      }
      expect(agents.patches).toHaveLength(3);
    });

    test("finishHunter: the write only lands on a draft (a second tab does not overwrite)", async () => {
      const agents = new FakeAgentStore();
      const id = await agentWith(agents, "draft");
      agents.setupRun = { status: "plan", plan: { summary: "s", places: [], sourceTypes: [], warnings: [] }, region_text: "Boston" } as unknown as RunRow;
      expect(await finishHunter(agents, owner, id, { name: "N", rigor: "careful", schedule: "weekly" })).toEqual({ ok: true });
      expect(agents.ifCalls).toEqual([[id, "draft"]]);
      // the other tab already moved it on between the read and the write: the write returns false -> still ok
      const spy = agents.updateAgentIf.bind(agents);
      agents.updateAgentIf = async (i, e, p) => {
        agents.agents.get(i)!.status = "running";
        return spy(i, e, p);
      };
      const id2 = await agentWith(agents, "draft");
      expect(await finishHunter(agents, owner, id2, { name: "N", rigor: "careful", schedule: "weekly" })).toEqual({ ok: true });
      expect(agents.agents.get(id2)!.status).toBe("running");
    });
  });

  describe("finishHunter", () => {
    const plan = { summary: "s", places: ["Boston"], sourceTypes: [], warnings: [] };
    const readyRun = (over: Partial<RunRow> = {}) => ({ status: "plan", plan, region_text: "Boston + Cape Cod", ...over }) as unknown as RunRow;
    const input = { name: "Caçador Boston", rigor: "careful", schedule: "weekly" };
    async function draft(agents: FakeAgentStore) {
      return agents.insertDraft({ workspaceId: "w1", name: "x", config: good as HunterSetup });
    }

    test("finishHunter: creates the agent PAUSED with name, rigor, schedule, the run's region and default caps", async () => {
      const agents = new FakeAgentStore();
      const id = await draft(agents);
      agents.setupRun = readyRun();
      expect(await finishHunter(agents, owner, id, input)).toEqual({ ok: true });
      const setup = hunterSetupSchema.parse(good);
      expect(agents.patches).toEqual([
        [id, { name: "Caçador Boston", status: "paused", schedule: "weekly", config: hunterConfig(setup, { name: "Caçador Boston", rigor: "careful", schedule: "weekly" }, "Boston + Cape Cod") }],
      ]);
      expect(agents.patches[0][1].config).toMatchObject({ caps: DEFAULT_CAPS.careful, region: "Boston + Cape Cod" });
    });

    test("finishHunter: refused while the plan is not ready; a second click changes nothing", async () => {
      const agents = new FakeAgentStore();
      const id = await draft(agents);
      agents.setupRun = readyRun({ plan: null });
      expect(await finishHunter(agents, owner, id, input)).toEqual({ ok: false, error: "not_ready" });
      agents.setupRun = readyRun({ status: "questions" });
      expect(await finishHunter(agents, owner, id, input)).toEqual({ ok: false, error: "not_ready" });
      agents.setupRun = null;
      expect(await finishHunter(agents, owner, id, input)).toEqual({ ok: false, error: "not_ready" });
      expect(agents.patches).toHaveLength(0);
      agents.agents.get(id)!.status = "paused";
      agents.setupRun = readyRun();
      expect(await finishHunter(agents, owner, id, input)).toEqual({ ok: true });
      expect(agents.patches).toHaveLength(0);
    });

    test("finishHunter: the closer is refused; bad name, rigor or schedule come back as field errors", async () => {
      const agents = new FakeAgentStore();
      const id = await draft(agents);
      agents.setupRun = readyRun();
      expect(await finishHunter(agents, { workspaceId: "w1", role: "closer" }, id, input)).toEqual({ ok: false, error: "forbidden" });
      const a = await finishHunter(agents, owner, id, { ...input, name: "" });
      expect(a.ok === false && a.error === "invalid" && a.fieldErrors?.name).toBeTruthy();
      const b = await finishHunter(agents, owner, id, { ...input, schedule: "hourly" });
      expect(b.ok === false && b.fieldErrors?.schedule).toBeTruthy();
      const c = await finishHunter(agents, owner, id, { ...input, rigor: "wild" });
      expect(c.ok === false && c.fieldErrors?.rigor).toBeTruthy();
      expect(await finishHunter(agents, { workspaceId: "w2", role: "owner" }, id, input)).toEqual({ ok: false, error: "not_found" });
      expect(agents.patches).toHaveLength(0);
    });
  });
});
