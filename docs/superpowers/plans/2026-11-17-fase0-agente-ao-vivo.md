# Fase 0 — Agente ao vivo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking "Rodar agora" on a Caçador starts a run within the next clock tick, and the agent page shows the run live (state, stage, companies found, cost, last company) without reloading. The agent list shows what each agent is doing.

**Architecture:** A SECURITY DEFINER RPC `run_hunter_now` sets the agent `running` and `next_run_at = now()`, so the existing per-minute `kolmeia-hunter` cron picks it up (`hunter_due_work`). A read-only route `GET /api/agents/[id]/live` returns a small JSON view built by a pure mapper. A client panel polls it (3 s while queued/running, 30 s otherwise, paused when the tab is hidden). No change to the hunter engine or the cron.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind 4, Supabase (Postgres, RLS), zod 4, vitest 4 + PGlite.

**Spec:** `docs/superpowers/specs/2026-11-17-motor-de-dados-design.md` §6.4 and §7 (Fase 0).

## Global Constraints
- App dir: `kolmeia/.claude/worktrees/f7-leads-redesign/app`, branch `leads-redesign`; deploy = push to `main` (orchestrator does it, not tasks).
- Design: navy `#0F1B3D`, honey `#F5A400` accents only, never white text on honey; big blocks `HexPanel`, small pieces rounded; shared components from `@/components/ui` (see `scratchpad/redesign-brief.md` rules); motion off under reduced motion; targets ≥ 44px; `aria-live="polite"` for live text.
- Every UI string in `src/messages/pt/agents.ts` AND `src/messages/en/agents.ts` (en `satisfies Widen<typeof pt>`). Never the word "LinkedIn" in UI copy.
- Only owner + sdr (senders) can run an agent; closers never see the button.
- Never change sending flags, never apply migration 0012, back up prod before applying the new migration (orchestrator does it).
- Public repo: no secrets, no real lead data in tests.
- New migration number: `0039`.

## Review Focus
1. Double click / "Rodar agora" while a run is already `ready` or `running` → no second run; the UI says it is already working (Task 1 test `already_running`).
2. Agent paused by a spend cap (`paused_reason` = `daily_cap`/`user_cap`/`global_cap`/`no_access`) → the panel shows the reason in plain words instead of an endless spinner (Task 2 test).
3. Clock stopped / no AI key → panel stuck in "starting": after 3 minutes queued with no run, show "Ainda não começou…" hint (Task 2 test `stale`).
4. Closer or another workspace → RPC raises `not allowed`, route returns 404 (Task 1 + Task 3 tests).
5. Fourth hunter turned on in a workspace (A7) → returns `too_many`, message shown (Task 1 test).

---

### Task 1: RPC `run_hunter_now`

**Files:**
- Create: `supabase/migrations/0039_run_hunter_now.sql`
- Test: `tests/db/hunter-run-now.test.ts` (use `tests/db/hunter-seed.ts` + `helpers.ts`, like `hunter-agents.test.ts`)

**Interfaces:**
- Produces: `public.run_hunter_now(p_agent uuid) returns text` → one of `'queued' | 'already_running' | 'too_many'`; raises `42501 'not allowed'` when caller is not `public.is_workspace_sender(agent.workspace_id)`, `22023` when not a hunter, `55000` when archived or `draft`.

- [ ] **Step 1: Write failing tests** in `tests/db/hunter-run-now.test.ts`:
  - `queued from paused`: paused hunter with `next_run_at` in 7 days → returns `'queued'`; row has `status='running'`, `next_run_at <= now()`, `paused_reason is null`.
  - `queued from running`: running hunter, next_run_at in 7 days, no live run → `'queued'`, `next_run_at <= now()`.
  - `already_running`: a `research_runs` row with `agent_id` = agent and status `ready` (and again with `running`) → `'already_running'`, `next_run_at` unchanged.
  - `too_many`: 3 other running hunters in the workspace, this one paused → `'too_many'`, status stays `paused`.
  - `closer refused`, `other workspace refused`: raise `not allowed`.
  - `draft refused`, `archived refused`, `email agent refused`.
- [ ] **Step 2:** `npx vitest run tests/db/hunter-run-now.test.ts` → FAIL (function missing).
- [ ] **Step 3: Implement** the migration, wrapped in `begin; … commit;`. `security definer`, `set search_path = ''`, `revoke all … from public, anon; grant execute … to authenticated`. Lock the agent row (`for update`). Two separate updates are required: `guard_agent` (0023) resets `next_run_at` to `coalesce(old.next_run_at, now())` on paused→running, so first `update … set status='running'` (catch `23514` whose message starts with `A7` → return `'too_many'`), then `update … set next_run_at = now()`. Live run check: `exists (select 1 from public.research_runs r where r.agent_id = p_agent and r.status in ('ready','running'))`.
- [ ] **Step 4:** test → PASS; `npx vitest run tests/db/hunter-agents.test.ts tests/db/hunter-path.test.ts` still PASS.
- [ ] **Step 5: Commit** `feat(agents): run_hunter_now RPC (0039)`.

### Task 2: Live view mapper

**Files:**
- Create: `src/lib/agents/live.ts`
- Test: `tests/unit/agent-live.test.ts`

**Interfaces:**
- Produces:
```ts
export type AgentLiveState = "idle" | "queued" | "running" | "paused" | "done" | "failed";
export type AgentLive = {
  state: AgentLiveState;
  stale: boolean;               // queued > 3 min with no run started
  pausedReason: string | null;  // agents.paused_reason or run.progress.pauseReason
  nextRunAt: string | null;
  run: null | { id: string; status: string; startedAt: string | null; finishedAt: string | null;
    stage: string | null; spentUsd: number; maxUsd: number | null; found: number; maxFound: number | null;
    lastName: string | null; error: string | null };
};
export function agentLiveView(input: { agent: { status: string; next_run_at: string | null; paused_reason: string | null };
  run: (RunRow-like subset) | null; found: number; lastName: string | null; now: Date }): AgentLive;
```
  State rules: agent `paused` → `paused`; run `ready` → `queued`; run `running` → `running`; agent `running` and `next_run_at <= now` and no live run → `queued`; last run `done`/`failed` and nothing pending → `done`/`failed`; otherwise `idle`. `stale` = state `queued` and `now - next_run_at > 3 min`.

- [ ] **Step 1: Failing tests** for each state rule, `stale` true at 3 min 1 s and false at 2 min 59 s, `pausedReason` taken from `progress.pauseReason` when the run is paused by a cap, money as numbers (`spent_cost_usd` may come as string from PostgREST → `Number()`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (pure, no I/O). **Step 4:** PASS. **Step 5:** commit `feat(agents): live view mapper`.

### Task 3: Live route + "Rodar agora" action

**Files:**
- Create: `src/app/api/agents/[id]/live/route.ts`
- Modify: `src/app/(app)/agentes/agent-actions.ts` (add `runHunterNowAction`)
- Test: `tests/unit/agent-live-route.test.ts` (source-level/handler test with a fake supabase, following existing route tests), `tests/unit/agents-commands.test.ts` if commands change

**Interfaces:**
- Consumes: `agentLiveView` (Task 2), RPC `run_hunter_now` (Task 1).
- Produces: `GET /api/agents/[id]/live` → `200 AgentLive` JSON, `Cache-Control: no-store`; `404` for invalid uuid, no session, agent not visible (RLS) or not a hunter. Reads with the user session (`createClient` from `@/lib/supabase/server`): the agent row, the latest run where `agent_id = id` (order `created_at desc`, limit 1, columns needed only), candidate count + latest candidate `name` for that run.
- Produces: `runHunterNowAction(agentId: string): Promise<FormState>` — `requireSender()`, uuid check, calls `supabase.rpc("run_hunter_now", { p_agent })`, maps `queued`→success, `already_running`→success with message key `alreadyRunning`, `too_many`→error `t.agents.hunter.errors.tooMany` (reuse if it exists), any DB error → generic error (never echo internals). `revalidatePath("/agentes")` and `/agentes/${id}`.

- [ ] **Step 1: Failing tests:** 404 on bad uuid; 404 when agent missing; 200 shape on a running run; action maps the 3 outcomes.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + `npm run typecheck`. **Step 5:** commit `feat(agents): live route and run-now action`.

### Task 4: Live panel on the agent page

**Files:**
- Create: `src/components/agents/AgentLivePanel.tsx` (client)
- Modify: `src/components/agents/AgentDetail.tsx` (mount the panel at the top for hunters not in `draft`), `src/components/agents/AgentPowerButton.tsx` (after success call `router.refresh()`; show pending label while the transition runs)
- Modify: `src/messages/pt/agents.ts`, `src/messages/en/agents.ts`
- Test: `tests/unit/agent-live-panel.test.ts` (source-text checks like other component tests: polling interval constants, `visibilitychange`, `aria-live`)

**Interfaces:**
- Consumes: `AgentLive` (Task 2), `GET /api/agents/[id]/live`, `runHunterNowAction` (Task 3).
- Produces: `<AgentLivePanel agentId initial={AgentLive} canRun={boolean} />`; exported constants `LIVE_FAST_MS = 3000`, `LIVE_SLOW_MS = 30000`.

Look (matches the approved sketch in the spec §6.4 conversation):
```
┌ HexPanel (navy when running/queued, white otherwise) ───────────────┐
│ ● Trabalhando / Na fila / Pausado: <motivo> / Parado          [Rodar agora] │
│ ⬢⬢⬢⬡⬡⬡  etapa atual (label per Stage)                           │
│ Empresas achadas: N de M · Gasto: US$ x de US$ y · Começou há 3 min │
│ Último achado: "<nome>"                                              │
│ (stale) Ainda não começou. O relógio passa a cada minuto; se passar  │
│ de alguns minutos, avise o responsável.                              │
└─────────────────────────────────────────────────────────────────────┘
```
- Stage labels: one pt/en label per `Stage` value in `src/lib/research/types.ts`, shown in engine order as hexagon dots (done = honey, current = pulsing honey ring, todo = line color).
- "Rodar agora": HexButton tone honey, shown when `canRun` and state ∈ {idle, done, failed, paused}; disabled while pending; on `alreadyRunning` show the info line, never an error.
- Polling: `setTimeout` loop, `LIVE_FAST_MS` when state ∈ {queued, running}, else `LIVE_SLOW_MS`; stop when `document.hidden`, resume on `visibilitychange`; abort on unmount; on transition to `done` call `router.refresh()` once so history/metrics update.
- Paused reasons in plain words: user, daily_cap, user_cap, global_cap, no_access, error.

- [ ] **Step 1:** failing source tests. **Step 2:** FAIL. **Step 3:** implement + strings. **Step 4:** `npm run typecheck`, `npx vitest run tests/unit` PASS. **Step 5:** commit `feat(agents): live panel and run-now button`.

### Task 5: What each agent is doing, in the list

**Files:**
- Modify: `src/lib/agents/view.ts` (`metricOf` for hunters), `src/app/(app)/agentes/page.tsx` (load each listed hunter's latest run: status, finished_at, candidate count — one query for all listed agent ids, no N+1)
- Modify: pt/en `agents.ts`
- Test: `tests/unit/agents.test.ts` (extend `agentRowView` cases)

**Interfaces:**
- `agentRowView(a, now, t, opts)` gains `opts.lastRun?: { status: string; finishedAt: string | null; found: number }`.
- Hunter metric text: running run → "● Trabalhando agora"; queued → "Na fila: começa em até 1 minuto"; last run done → "Rodou há {ago}, achou {n}"; else existing "Próxima: {when}" text.

- [ ] **Step 1:** failing cases for the 4 texts (pt). **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck. **Step 5:** commit `feat(agents): live status in the agent list`.

### Task 6: Verify in production (orchestrator)
- [ ] Backup prod (`/bin/zsh ~/kolmeia-backups/bin/kolmeia-backup-prod.sh`), apply `0039` to prod, push `main`, deploy with the kolmeia Vercel config.
- [ ] Chrome (Juan's session): open the Caçador, click "Rodar agora", see "Na fila" → "Trabalhando" within ~1 min, counts rising, then "Rodou há …" in the list. Note: a real run spends up to the agent cap (US$ 3) — ask Juan before clicking.
- [ ] Phone width check of the panel (375 px iframe method).
