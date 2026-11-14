# F2 Galeria + Criação de Agentes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Juan creates a Caçador through a guided chat (gallery → 3 fixed questions → the AI's questions → rigor + frequency → review card) and the agent appears PAUSADO in "Meus agentes"; the closer no longer sees AGENTES or CAMPANHAS.
**Architecture:** One new table `agents` (migration 0008) with forced RLS for owner/sdr only. The chat reuses the research flow unchanged: after the 3 fixed questions the server creates a draft agent plus a normal `research_runs` row linked by the new column `setup_agent_id`; the existing `RunDriver` → `/api/research/[id]/advance` → `askQuestions`/`writePlan` (same AI gateway, caps and `ai_calls` ledger) produce the questions and the plan; a new review card replaces "Aprovar e buscar" with "Criar agente (pausado)". The database refuses to approve or run a setup run (A5), so in F2 **nothing runs**: running the Caçador in the background is F3, e-mail sending is F4, calls are F5.
**Tech Stack:** Next.js 16.4.5 App Router, React 19.3, Tailwind 4, TypeScript, zod 4, Supabase/Postgres (PGlite in tests), vitest (node env, no DOM).
**Spec:** `kolmeia/docs/superpowers/specs/2026-11-14-kolmeia-3-areas-design.md` — sections 5.1, 5.2, 6.1-6.7, 10 (row F2), decisions J2, C4, C9, C11.

`APP` = `kolmeia/app`. Every command runs from `APP` unless it starts with `cd`.

## Global Constraints
- F2 "pronto quando": "o Juan cria um Caçador pelo chat, vê o cartão de revisão e o agente aparece PAUSADO na lista".
- Agents are born PAUSED (spec 6.5). In F2 no agent runs: no "Ligar", no cron, no `next_run_at` written, no `agent_runs` table. The setup research only asks questions and writes a plan (2 AI calls, same as today's Pesquisa before "Aprovar").
- Only the Caçador can be created. Gallery shows `E-mail` and `Ligação` as "Em breve" (no button), and "Ligação por IA: em breve (desligada)".
- Roles (J2): the enum `owner|sdr|closer` and `is_workspace_sender()` (owner or sdr) already exist (0001, 0003). F2 uses them; it adds no role column and no role-management screen.
- Closer: menu = LEADS only (⚙ stays); `/agentes`, `/agentes/novo`, `/agentes/[id]` and all of `/campanhas` redirect her to `/leads`. `/agentes/pesquisa/[id]` stays open to her (LEADS still links there until F3). Sua empresa is read-only for her.
- Reuse, do not fork: `QuestionsForm`, `RunDriver`, `answerQuestions`/`adjustResearch` server actions, `createRun`, `DEFAULT_CAPS`, `RIGORS`, `t.research.plan.rigorNames`/`rigorHelp`, `Choice`/`DarkChoice`/`PrimaryButton`/`GhostButton`, `usd()`. No new AI task, no new prompt, no change to `lib/ai`. The setup page must never render `PlanCard` or `Conversation` (both carry "Aprovar plano e buscar").
- No AI key (`hasAi()` false): the chat still saves the 3 answers as a draft, shows `t.ai.notConfigured` + `t.agents.hunter.noAi`, and the draft is listed with "Continuar"; when the key exists, opening the draft resumes (RunDriver).
- Copy: Brazilian Portuguese, short; identifiers English; never "pearchat" in `src`. New file `src/messages/pt/agents.ts` exports `agents` (spread in `index.ts` as `t.agents`; remove `agents` from `areas.ts`). Values the spec fixes (use verbatim):
  - `title: "Agentes"`, `newAgent: "+ Novo agente"`, `mine: "Meus agentes"`, `types: { hunter: "Caçador", email: "E-mail", call: "Ligação" }`, `statuses: { draft: "rascunho", paused: "pausado", running: "rodando", done: "concluído" }`.
  - Gallery: `gallery.title: "Novo agente"`, `gallery.describe: "Descreva o que você quer..."`, cards `hunter: "Acha leads com prova"`, `email: "Escreve e envia após OK"`, `call: "Lista do dia para a closer"`, `aiCall: "Ligação por IA: em breve (desligada)"`, `create: "Criar"`, `soon: "Em breve"`.
  - Questions (6.3): `q1: "De onde puxo os dados da sua empresa?"` options `"Perfil salvo"` · `"Descrever"`; `q2: "Quem você quer achar?"` options `audiences: { builder: "Construtores", developer: "Incorporadoras", property_manager: "Administradoras", other: "Outro" }`; `q3: "Onde?"`; `q5: "Quanto rigor?"` (options = `t.research.plan.rigorNames`); `q6: "Com que frequência?"` options `schedules: { once: "Uma vez", weekly: "Toda semana", daily: "Todo dia" }` (default `weekly`, C4).
  - Review (6.4): `review.title: "Revisão: {name}"`, rows `"Alvo"`, `"Região"`, `"Rigor"`, `"Frequência"`, `"Fontes"` = `"web_search, web_fetch (sem LinkedIn)"`, `"Custo máximo por execução"` = `usd(DEFAULT_CAPS[rigor].maxCostUsd)`, `"Tempo máximo"` = `"até {minutes} min"` (`DEFAULT_CAPS[rigor].maxMinutes`), `"Limite"` = `"máx. {n} empresas por execução"` (`DEFAULT_CAPS[rigor].maxCandidates`); `review.paused: "O agente nasce PAUSADO: não roda e não gasta nada até você ligar."`; buttons `"Voltar"` and `"Criar agente (pausado)"`. Cost and time are the rigor's ceilings, labelled "máximo": never an invented estimate (spec 6.4).
  - Other strings (errors, hints, `noAi`, `setupFailed`, `restart: "Recomeçar"`, `continue: "Continuar"`, `archive: "Arquivar"`, `metric.draft: "Falta terminar a criação"`, `metric.neverRan: "Ainda não rodou"`, `detail.turnOnSoon: "Ligar chega na próxima versão. Até lá o agente fica pausado e não gasta nada."`): implementer writes, same tone.
  - `t.roles.closerNotice` (in `common.ts`): `"Você está como closer: vê os leads e o que passaram para você. Agentes, campanhas e configurações são do dono e do SDR."` It replaces `t.email.readOnly` everywhere; that key is deleted.
- Migration `supabase/migrations/0008_agents.sql`: re-runnable style of 0001-0007 (`if not exists`, `drop policy if exists`, revoke-then-grant, `security definer` + `set search_path = ''`). It depends only on 0001-0004 (+ `is_workspace_sender`/`is_client_role` from 0003). Tested on PGlite only. Applying it to the real Supabase is NOT a task (C9): it is the last line of the manual checklist. Deploy order: 0008 first, then the code (`getRun` selects `setup_agent_id`).
- Next 16 differs from training data (`APP/AGENTS.md`): before Task 4 read `node_modules/next/dist/docs/` on `revalidatePath`, `redirect` in layouts/pages, and `useActionState`.
- Tests never touch the real Supabase: DB tests use `tests/db/helpers.ts` (PGlite, real migrations); command tests use in-memory fakes.
- E3 stays stopped: F2 edits only `campanhas/layout.tsx` in that area. Do not touch `.superpowers/sdd/e3/`.
- No git in `kolmeia/`: "Checkpoint" = run the command shown. Before Task 1: `cd kolmeia && tar -czf .backups/app-F2-$(date +%F).tgz --exclude node_modules --exclude .next app`. SDD workspace `kolmeia/.superpowers/sdd/f2/` with copies of `f1/pkg.sh` and `f1/next.sh` (`W=.superpowers/sdd/f2`), ledger `f2/progress.md`.
- Baseline (14/11/2026, after F1): `npx vitest run` → 723 passed | 3 todo, 27 files.

## Review Focus
1. **A setup run gets approved as a normal search** (old tab, `/agentes/pesquisa/<setupRunId>`, a crafted call) and spends AI money while the agent says "pausado". Expect: refused by the database, and the URL opens the agent. Owners: Task 1 (`A5 a setup run cannot be approved or run; it can be cancelled`), Task 5 (`/agentes/pesquisa/<setup run> opens the agent instead`).
2. **No AI key, or an AI cap hit mid-chat** leaves an endless spinner or an error page. Expect: a plain notice, the draft listed with "Continuar", resume later. Owner: Task 2 (`hunterStep without AI waits as a draft instead of failing`).
3. **The closer reaches agent screens by URL or calls the server action directly.** Expect: sent to LEADS; nothing created. Owners: Task 1 (`J2 owner and sdr create and read agents; the closer sees none and cannot create`), Task 4 (`startHunter: the closer is refused and nothing is created`).
4. **Double click / two tabs on "Criar agente (pausado)", or clicking while "Ajustar" is rewriting the plan.** Expect: the second click changes nothing; creating without a plan is refused with a message. Owner: Task 5 (`finishHunter: refused while the plan is not ready; a second click changes nothing`).
5. **Long saved profile** (`service_area` up to 2000 chars) offered as the region (limit 1000), or a long audience/region turning into a name over 80 chars. Expect: clipped, never a failed insert. Owner: Task 2 (`regionOptions clips the profile area; defaultAgentName never passes 80 characters`).

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/supabase/migrations/0008_agents.sql` (T1) | `agents`, `research_runs.setup_agent_id`, guards A1-A5, RLS, company profile write = owner/sdr |
| `APP/tests/db/agents.test.ts` (T1) | DB rules above |
| `APP/src/lib/agents/types.ts` (T2) | `AGENT_TYPES`, `AGENT_STATUSES`, `SCHEDULES`, `AgentRow`, `AgentPatch` |
| `APP/src/lib/agents/hunter.ts` (T2) | client-safe: setup/finish schemas, request text, default name, config, region options |
| `APP/src/lib/agents/steps.ts` (T2) | `hunterStep`: which part of the chat to show |
| `APP/src/lib/agents/view.ts` (T2) | `agentRowView`: one line of "Meus agentes" |
| `APP/src/messages/pt/agents.ts` (T2), `areas.ts`, `index.ts`, `common.ts`, `email.ts` | copy |
| `APP/src/lib/roles.ts` (T3) | `Role`, `isSender` |
| `APP/src/lib/workspace.ts`, `src/lib/nav.ts`, `components/{Header,NavLinks}.tsx`, `(app)/layout.tsx` (T3) | `requireSender`, `areasFor`, menu by role |
| `APP/src/app/(app)/{campanhas,leads,configuracoes}/layout.tsx`, `configuracoes/empresa/{page,ProfileForm}.tsx` (T3) | closer redirect / notice / read-only |
| `APP/src/lib/agents/store.ts` (T4) | `AgentStore` interface + `SupabaseAgentStore` (server-only) |
| `APP/src/lib/agents/commands.ts` (T4, grows T5) | `startHunter`, `archiveAgent`, `finishHunter` |
| `APP/src/app/(app)/agentes/agent-actions.ts` (T4, grows T5) | server actions wrapping the commands |
| `APP/src/app/(app)/agentes/{layout,page}.tsx`, `pesquisa/layout.tsx`, `novo/page.tsx` (T4) | area header, Meus agentes + Pesquisa avulsa, run-list column, gallery |
| `APP/src/components/agents/{AgentList,AgentGallery,HunterStartForm,ArchiveButton}.tsx` (T4) | list, gallery, questions 1-3, archive |
| `APP/src/app/(app)/agentes/[id]/page.tsx`, `components/agents/{HunterReviewCard,AgentDetail}.tsx` (T5) | chat, review card, detail |
| `APP/src/lib/research/{store,commands,rows,supabase-store}.ts`, `tests/engine/sql-store.ts` (T4) | `setupAgentId` on run creation; `setup_agent_id` on `RunRow` |
| `APP/tests/unit/{agents,agents-commands,nav}.test.ts` | unit, command and source-scan tests |
| `APP/README.md` (T5) | Portuguese: how to create a Caçador; F2 limits |

---

### Task 1: Migration 0008 — agents, setup link, role rules

**Files:** Create `supabase/migrations/0008_agents.sql`, `tests/db/agents.test.ts`.
**Interfaces:** Produces table `public.agents` (`id uuid pk default gen_random_uuid()`, `workspace_id uuid not null → workspaces on delete cascade`, `type text check in ('hunter','email','call')`, `name text check char_length(btrim(name)) between 1 and 80`, `status text not null default 'draft' check in ('draft','paused','running','done')`, `config jsonb not null default '{}' check jsonb_typeof = 'object' and octet_length(config::text) <= 16000`, `schedule text not null default 'weekly' check in ('once','weekly','daily')`, `next_run_at timestamptz`, `archived_at timestamptz`, `created_by uuid → auth.users on delete set null`, `created_at`, `updated_at timestamptz not null default now()`; index `(workspace_id, created_at desc)`); column `research_runs.setup_agent_id uuid → agents on delete set null` with partial unique index `where setup_agent_id is not null`.

- [ ] Step 1: Backup + baseline (Global Constraints) → 723 passed | 3 todo.
- [ ] Step 2: Write `tests/db/agents.test.ts` (setup like `research-rls.test.ts`: `TestDb.create()`, owner A creates wsA, owner B creates wsB, `db.admin` adds `UUID_C` as `sdr` and `UUID_D` as `closer` of wsA; helper `draft(user, ws)` inserts `(workspace_id, type, name) values ($1,'hunter','Caçador X')`; helper `setupRun(user, ws, agent)` inserts a research run with `setup_agent_id`). Tests, one `describe("0008 agents")`:
  - `agents: RLS on and forced; anon has nothing` — `relrowsecurity` and `relforcerowsecurity` true; `anon` select → error.
  - `J2 owner and sdr create and read agents; the closer sees none and cannot create` — A and C insert ok and see both rows; D `select count(*)` → 0; D insert → error.
  - `R8 a member of another workspace cannot read, insert or update agents of this one` — B: select 0 rows, insert into wsA → error, update → 0 rows.
  - `A1 a new agent is a draft stamped by the database` — insert with `status 'paused'` as A → row has `status = 'draft'`, `created_by = A`, `archived_at is null`; insert naming `next_run_at` or `created_by` → permission error (42501).
  - `A2 a setup run needs a draft hunter of the same workspace, started by owner or sdr; one per agent` — ok for A's draft; error for: agent of wsB, a `paused` agent (set by admin), an `email` agent, the closer D (even with A's draft), a second setup run for the same agent.
  - `A3 draft becomes paused only when its setup run has a plan; running, done and back-to-draft are refused` — draft without run → `status='paused'` error; run with `status='plan'` and `plan` set by admin → ok; then `'running'`, `'done'`, `'draft'` → error.
  - `A4 archiving stamps the database clock and freezes the agent` — `archived_at = '2000-01-01'` → stored value ≥ test start; a later `name` update → error.
  - `A5 a setup run cannot be approved or run; it can be cancelled` — with plan set: update `status='ready'` → error mentioning `A5`; `status='cancelled'` → ok. A run without `setup_agent_id` still goes `plan → ready` (no regression).
  - `J2 company profile: the closer reads but cannot insert or update; owner and sdr can` — D insert/update `company_profiles` of wsA → error / 0 rows; D select → sees it; C update → 1 row.
- [ ] Step 3: Run `npx vitest run tests/db/agents.test.ts` → FAIL (`relation "public.agents" does not exist`).
- [ ] Step 4: Write `0008_agents.sql`:
  - Table + index above. `revoke all` from `public, anon, authenticated`; `grant select`; `grant insert (workspace_id, type, name, config, schedule)`; `grant update (name, status, config, schedule, archived_at)`; no delete. RLS enable + force; policies `agents_select|insert|update` `to authenticated` with `public.is_workspace_sender(workspace_id)` in `using`/`with check`.
  - `guard_agent()` before insert or update (security definer): insert → `status := 'draft'`, `created_by := auth.uid()`, `created_at := now()`, `archived_at := null`, `next_run_at := null`. Update → if `old.archived_at` not null raise `A4: an archived agent cannot change`; if `archived_at` changed → `new.archived_at := now()`; when `public.is_client_role()` and status changed: only `draft → paused`, and only if a `research_runs` row with `setup_agent_id = new.id`, `status = 'plan'`, `plan is not null` exists, else raise `A3: ...`; always `updated_at := now()`. Errors use errcode `23514`.
  - `research_runs`: add column + unique index; `grant insert (setup_agent_id)`. `guard_agent_setup_run()` before insert or update (security definer): insert with `setup_agent_id` → requires `is_workspace_sender(new.workspace_id)` and an agent with that id, same `workspace_id`, `type = 'hunter'`, `status = 'draft'`, `archived_at is null`, else raise `A2: ...`; any row with `setup_agent_id` not null whose new status is not in `('questions','plan','cancelled')` → raise `A5: an agent's setup research cannot run`.
  - `company_profiles_insert` / `company_profiles_update`: recreate with `public.is_workspace_sender(workspace_id)` (select stays member, delete stays owner).
- [ ] Step 5: Run the file → PASS. Checkpoint `npx vitest run` → 732 passed | 3 todo (existing DB tests unchanged).

### Task 2: Agent vocabulary, Caçador rules, chat step, copy

**Files:** Create `src/lib/agents/{types,hunter,steps,view}.ts`, `src/messages/pt/agents.ts`, `tests/unit/agents.test.ts`. Modify `src/messages/pt/{areas,index}.ts`.
**Interfaces:**
- Produces (`types.ts`): `AGENT_TYPES = ["hunter","email","call"] as const`, `AGENT_STATUSES = ["draft","paused","running","done"] as const`, `SCHEDULES = ["once","weekly","daily"] as const`, their `AgentType`/`AgentStatus`/`Schedule`; `AgentRow = { id; workspace_id; type: AgentType; name; status: AgentStatus; config: Record<string, unknown>; schedule: Schedule; next_run_at: string | null; archived_at: string | null; created_at; updated_at }`; `AgentPatch = Partial<Pick<AgentRow, "name" | "status" | "config" | "schedule" | "archived_at">>`.
- Produces (`hunter.ts`, client-safe, no server imports): `AUDIENCES = ["builder","developer","property_manager","other"] as const`; `hunterSetupSchema` (zod object `profileSource: enum ["saved","describe"]`, `companyNote: string trim max 1400`, `audience: enum AUDIENCES`, `audienceText: string trim max 500`, `region: string trim min 1 max 1000`; superRefine: `describe` → `companyNote` min 1 (path `companyNote`); `other` → `audienceText` min 1 (path `audienceText`)); `HunterSetup`; `hunterFinishSchema` (`name: trim 1..80`, `rigor: enum RIGORS`, `schedule: enum SCHEDULES`); `HunterFinish`; `HunterConfig = HunterSetup & { rigor: Rigor; caps: { maxCandidates: number; maxCostUsd: number; maxMinutes: number } }`; `hunterRequest(s: HunterSetup): string`; `defaultAgentName(s: HunterSetup): string`; `hunterConfig(s: HunterSetup, f: HunterFinish, runRegion: string): HunterConfig`; `regionOptions(serviceArea: string): string[]`.
- Produces (`steps.ts`): `type HunterStep = "thinking" | "questions" | "planning" | "choose" | "no_ai" | "setup_failed" | "created"`; `hunterStep(agent: Pick<AgentRow, "status">, run: Pick<RunRow, "status" | "questions" | "plan"> | null, ai: boolean): HunterStep`.
- Produces (`view.ts`): `agentRowView(a: AgentRow): { href: string; type: string; status: string; metric: string; cta: string }`.
- Produces `t.agents` (Global Constraints).

- [ ] Step 1: Failing tests in `tests/unit/agents.test.ts` (`describe("F2 agents")`):
  - `hunter setup: describe needs a note, other needs a text, region is required and bounded` — `profileSource:"describe", companyNote:""` → error at `companyNote`; `audience:"other", audienceText:"  "` → error at `audienceText`; `region:""` and a 1001-char region → error at `region`; `{saved, "", builder, "", "Boston"}` → success.
  - `hunterRequest builds the research request from the answers` — builder/saved → `"Achar construtores"`; `other` + `"GCs comerciais"` → `"Achar GCs comerciais"`; property_manager/describe + note `"Fazemos HVAC"` → `"Achar administradoras\n\nSobre a nossa empresa: Fazemos HVAC"`; any valid setup → length ≤ 2000.
  - `regionOptions clips the profile area; defaultAgentName never passes 80 characters` — `regionOptions("")` → `[]`; `regionOptions("  Boston  ")` → `["Boston"]`; a 2000-char area → one option of length 1000; `defaultAgentName({builder, region "Boston"})` → `"Caçador Construtores Boston"`; a 1000-char region → length ≤ 80 ending in `…`.
  - `hunterConfig copies the run's region and the rigor's default caps` — `hunterConfig(setup, {name:"x", rigor:"strict", schedule:"daily"}, "Cape Cod")` has `region: "Cape Cod"`, `rigor: "strict"`, `caps` equal to `DEFAULT_CAPS.strict`.
  - `hunterStep: which part of the chat to show` — table: non-draft agent → `created`; run `null` / `failed` / `cancelled` / `ready` → `setup_failed`; `questions` + `questions:null` → `thinking`; `questions` + `[q]` → `questions`; `plan` + `plan:null` → `planning`; `plan` + plan → `choose`.
  - `hunterStep without AI waits as a draft instead of failing` — `ai=false`: `questions:null` → `no_ai`; `plan:null` → `no_ai`; but `[q]` → `questions` and plan present → `choose` (work already done still shows).
  - `agentRowView: draft continues, paused hunter has not run yet` — draft → `{ status: "rascunho", metric: t.agents.metric.draft, cta: "Continuar", href: "/agentes/<id>" }`; paused hunter → `{ type: "Caçador", status: "pausado", metric: t.agents.metric.neverRan, cta: "Abrir" }`.
- [ ] Step 2: Run `npx vitest run tests/unit/agents.test.ts` → FAIL (modules missing).
- [ ] Step 3: Implement. `hunterRequest`: `"Achar " + (other ? audienceText : audiences[a].toLowerCase())`, then `"\n\nSobre a nossa empresa: " + companyNote` only when `describe`. `defaultAgentName`: `"Caçador " + (other ? audienceText : audiences[a]) + " " + region`, whitespace collapsed, clipped like `titleFrom` (`lib/research/commands.ts`) but at 80. `regionOptions`: trim, empty → `[]`, else first 1000 chars. Copy file per Global Constraints; `index.ts` spreads `agents`; `areas.ts` drops it.
- [ ] Step 4: Run the file → PASS.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 739 passed | 3 todo. (`agentes/layout.tsx` still reads `t.agents.soon` until Task 4: keep a `soon` key in `agents.ts` until then.)

### Task 3: Roles in the shell (J2)

**Files:** Create `src/lib/roles.ts`. Modify `src/lib/workspace.ts`, `src/lib/nav.ts`, `src/components/{Header,NavLinks}.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/campanhas/layout.tsx`, `src/app/(app)/agentes/page.tsx`, `src/app/(app)/{leads,configuracoes}/layout.tsx`, `src/app/(app)/configuracoes/empresa/{page,ProfileForm}.tsx`, `src/messages/pt/{common,email}.ts`, `tests/unit/nav.test.ts`.
**Interfaces:** Produces `type Role = "owner" | "sdr" | "closer"` and `isSender(role: Role): boolean` (`roles.ts`, client-safe); `requireSender(): Promise<CurrentWorkspace>` (`workspace.ts`: no workspace or not a sender → `redirect("/leads")`); `areasFor(role: Role): readonly NavItem[]` (`nav.ts`; closer → only the `/leads` item; else `MAIN_AREAS`); `NavLinks({ variant, role })`; `Header({ workspaceName, role })`; `ProfileForm({ initial, readOnly })`; `t.roles.closerNotice`.

- [ ] Step 1: Failing tests in `nav.test.ts` (`describe("F2 roles")`):
  - `J2 the closer's menu is LEADS only; owner and sdr see the 3 areas` — `areasFor("closer").map(i=>i.href)` → `["/leads"]`; `areasFor("owner")` and `areasFor("sdr")` equal `MAIN_AREAS`; `isSender` true/true/false.
  - `J2 AGENTES and CAMPANHAS send the closer to LEADS` — each file of `const SENDER_ONLY = ["src/app/(app)/campanhas/layout.tsx", "src/app/(app)/agentes/page.tsx"]` contains `requireSender()`; `src/lib/workspace.ts` contains `redirect("/leads")`. (Tasks 4 and 5 append their pages to `SENDER_ONLY`.)
  - `J2 the closer notice replaces the old read-only copy` — `src/messages/pt/email.ts` does not contain `readOnly`; no file under `src` contains `t.email.readOnly`; `leads/layout.tsx` and `configuracoes/layout.tsx` contain `t.roles.closerNotice`; `campanhas/layout.tsx` does not contain `Notice`.
  - `J2 Sua empresa is read-only for the closer, and the bottom bar fits any number of areas` — `empresa/page.tsx` contains `isSender(`; `ProfileForm.tsx` contains `disabled={readOnly}`; `NavLinks.tsx` contains `areasFor(role)` and `auto-cols-fr` and not `grid-cols-3`; `Header.tsx` and `(app)/layout.tsx` pass `role=`.
- [ ] Step 2: Run `npx vitest run tests/unit/nav.test.ts` → FAIL.
- [ ] Step 3: Implement. `CurrentWorkspace["role"]` becomes `Role` (import type). NavLinks: items `areasFor(role)`, bottom bar `grid grid-flow-col auto-cols-fr` (rest of F1 classes unchanged). `(app)/layout.tsx` passes `workspace.role` to Header and the bottom NavLinks. `campanhas/layout.tsx` and `agentes/page.tsx` call `await requireSender()` first; campanhas drops the closer `Notice`. Leads/configurações layouts show `t.roles.closerNotice` for `role === "closer"`. ProfileForm: `readOnly` wraps the fields in `<fieldset disabled={readOnly}>` and hides the submit; `empresa/page.tsx` passes `readOnly={!isSender(workspace.role)}` (RLS from Task 1 is the real gate). Delete `email.readOnly`.
- [ ] Step 4: Run `nav.test.ts` → PASS.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 743 passed | 3 todo.

### Task 4: AGENTES list, gallery, start of the Caçador chat, archive

**Files:** Create `src/lib/agents/{store,commands}.ts`, `src/app/(app)/agentes/agent-actions.ts`, `src/app/(app)/agentes/pesquisa/layout.tsx`, `src/app/(app)/agentes/novo/page.tsx`, `src/components/agents/{AgentList,AgentGallery,HunterStartForm,ArchiveButton}.tsx`, `tests/unit/agents-commands.test.ts`. Modify `src/app/(app)/agentes/{layout,page}.tsx`, `src/lib/research/{store,commands,rows,supabase-store}.ts`, `tests/engine/sql-store.ts`, `src/messages/pt/agents.ts` (drop `soon`), `tests/unit/nav.test.ts` (`SENDER_ONLY` += `agentes/novo/page.tsx`).
**Interfaces:**
- Consumes Task 2 (`hunterSetupSchema`, `hunterRequest`, `defaultAgentName`, `regionOptions`, `agentRowView`, `AgentRow`, `AgentPatch`), Task 3 (`isSender`, `requireSender`, `Role`).
- Produces (`research`): `NewRun.setupAgentId?: string`; `createRun(store, workspaceId, input, setupAgentId?: string)`; `RunRow.setup_agent_id?: string | null` and `setup_agent_id` in `RUN_COLUMNS`; both stores insert `setup_agent_id` only when given.
- Produces (`store.ts`, `import "server-only"`): `interface AgentStore { insertDraft(a: { workspaceId: string; name: string; config: HunterSetup }): Promise<string>; getAgent(id: string): Promise<AgentRow | null>; updateAgent(id: string, patch: AgentPatch): Promise<void>; listAgents(workspaceId: string): Promise<AgentRow[]>; getSetupRun(agentId: string): Promise<RunRow | null> }` (`insertDraft` sends `type: "hunter"`, `schedule: "weekly"`; `listAgents` = not archived, newest first); `class SupabaseAgentStore implements AgentStore` (constructor takes the session client, RLS applies).
- Produces (`commands.ts`, pure, no server imports): `type Actor = { workspaceId: string; role: Role }`; `type CommandResult<T = object> = ({ ok: true } & T) | { ok: false; error: "forbidden" | "not_found" | "not_ready" | "invalid" | "generic"; fieldErrors?: Record<string, string> }`; `startHunter(agents: AgentStore, research: ResearchStore, actor: Actor, raw: unknown): Promise<CommandResult<{ agentId: string }>>`; `archiveAgent(agents: AgentStore, actor: Actor, agentId: string): Promise<CommandResult>`.
- Produces (`agent-actions.ts`, `"use server"`): `startHunterAction(_prev: FormState, formData: FormData): Promise<FormState>` (fields `profileSource`, `companyNote`, `audience`, `audienceText`, `region`; success → `redirect("/agentes/<agentId>")`); `archiveAgentAction(agentId: string): Promise<FormState>` (→ `redirect("/agentes")`); `restartHunterAction(agentId: string): Promise<FormState>` (archive → `redirect("/agentes/novo")`). Each builds the actor from `researchSession()`, validates `agentId` as uuid, maps `fieldErrors` keys to `t.agents.hunter.errors`, and calls `revalidatePath("/agentes", "layout")`.

- [ ] Step 1: Failing tests in `tests/unit/agents-commands.test.ts` with in-memory fakes (`FakeAgentStore` over a `Map`; a research fake implementing only `createRun`, cast `as unknown as ResearchStore`, recording its `NewRun`):
  - `startHunter: bad answers create nothing and say which field` — `region: ""` → `{ ok: false, error: "invalid", fieldErrors: { region: … } }`; no agent, no run.
  - `startHunter: the closer is refused and nothing is created` — role `closer` → `error: "forbidden"`; stores untouched.
  - `startHunter: creates a draft hunter and its setup research` — owner, `{saved, builder, region "Boston"}` → one agent named `"Caçador Construtores Boston"` with `config` = the parsed setup; one `NewRun` with `requestText "Achar construtores"`, `regionText "Boston"`, `rigor "careful"`, caps = `DEFAULT_CAPS.careful`, `setupAgentId` = the new agent id.
  - `archiveAgent: archives an agent of the workspace; the closer and other workspaces are refused` — owner → `updateAgent` got `archived_at` (string); closer → `forbidden`; agent of another workspace → `not_found`.
  - `the one-off research list hides agent setup runs` (source scan) — `agentes/page.tsx` and `agentes/pesquisa/layout.tsx` contain `.is("setup_agent_id", null)`.
- [ ] Step 2: Run `npx vitest run tests/unit/agents-commands.test.ts` → FAIL.
- [ ] Step 3: Implement:
  - Research plumbing per Interfaces (`tests/engine/sql-store.ts` mirrors `supabase-store.ts`).
  - Commands per Interfaces; `startHunter` order: role check → parse → `insertDraft` → `createRun(..., agentId)`; a `createRun` failure returns `generic` and leaves the draft (the chat shows `setup_failed` → "Recomeçar").
  - `agentes/layout.tsx`: `h1 t.agents.title` + (sender only) link `t.agents.newAgent` to `/agentes/novo`; children; no RunList, no `soon`.
  - `agentes/pesquisa/layout.tsx`: the two-column RunList aside that `agentes/layout.tsx` had, query + `.is("setup_agent_id", null)`.
  - `agentes/page.tsx` (`requireSender()`): section `t.agents.mine` with `<AgentList>` (empty → `t.agents.none` + link to `/agentes/novo`); section `t.agents.oneOff.title` with today's new-research form, its `hasAi` notice, and `<RunList>` of one-off runs (same query as the pesquisa layout).
  - `AgentList`: one row per `agentRowView` (name link, type, status badge, metric, cta link; draft/paused rows get `ArchiveButton`).
  - `agentes/novo/page.tsx` (`requireSender()`): reads `company_profiles.what_we_do, service_area` and `hasAi()` → `<AgentGallery hasProfile serviceArea ai />`.
  - `AgentGallery` (client): describe textarea (max 500) on top; cards Caçador (`Criar`), E-mail and Ligação (`Em breve`, no button), Ligação por IA (off). "Criar" (or Enter in the textarea) shows `HunterStartForm` below, with the typed text pre-filled as audience "Outro".
  - `HunterStartForm` (client, `useActionState(startHunterAction)`): three question cards in order (q1, q2, q3), each a row of `Choice` options plus an "Outro" text field where the spec has one; q1 "Perfil salvo" disabled when `!hasProfile` (with a link to `/configuracoes/empresa`), "Descrever" opens a textarea (max 1400, note that it adds to the saved profile); q3 options = `regionOptions(serviceArea)` + "Outro"; submit `t.agents.hunter.start` disabled while pending; field errors under each card; when `!ai` a notice that the agent stays a draft until the AI is on.
- [ ] Step 4: Run the file → PASS.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 748 passed | 3 todo.

### Task 5: The chat page, review card, creation PAUSED, detail, README, full check

**Files:** Create `src/app/(app)/agentes/[id]/page.tsx`, `src/components/agents/{HunterReviewCard,AgentDetail}.tsx`. Modify `src/lib/agents/commands.ts`, `src/app/(app)/agentes/agent-actions.ts`, `src/app/(app)/agentes/actions.ts` (`answerQuestions`, `adjustResearch` also `revalidatePath("/agentes", "layout")`), `src/app/(app)/agentes/pesquisa/[id]/page.tsx`, `tests/unit/{agents-commands,nav}.test.ts` (`SENDER_ONLY` += `agentes/[id]/page.tsx`), `README.md`.
**Interfaces:**
- Consumes `hunterStep`, `hunterFinishSchema`, `hunterConfig`, `AgentStore`, `Actor`, `CommandResult`, `QuestionsForm`, `RunDriver`, `adjustResearch`.
- Produces `finishHunter(agents: AgentStore, actor: Actor, agentId: string, raw: unknown): Promise<CommandResult>`; `finishHunterAction(agentId: string, input: { name: string; rigor: string; schedule: string }): Promise<FormState>` (success → `revalidatePath("/agentes", "layout")` + `redirect("/agentes")`); `HunterReviewCard({ agentId, run, defaultName })`; `AgentDetail({ agent, setupRun })`.

- [ ] Step 1: Failing tests:
  - `agents-commands.test.ts`: `finishHunter: creates the agent PAUSED with name, rigor, schedule, the run's region and default caps` — draft + setup run `{status:"plan", plan:{…}, region_text:"Boston + Cape Cod"}`, input `{name:"Caçador Boston", rigor:"careful", schedule:"weekly"}` → `updateAgent` got `{ name, status: "paused", schedule: "weekly", config: hunterConfig(setup, input, "Boston + Cape Cod") }`.
  - `agents-commands.test.ts`: `finishHunter: refused while the plan is not ready; a second click changes nothing` — run `plan:null` → `not_ready`, no update; agent already `paused` → `{ ok: true }` and no update.
  - `agents-commands.test.ts`: `finishHunter: the closer is refused; bad name, rigor or schedule come back as field errors` — closer → `forbidden`; `name:""` → `fieldErrors.name`; `schedule:"hourly"` → `fieldErrors.schedule`.
  - `nav.test.ts`: `the setup chat never shows the approve-and-search card` — `agentes/[id]/page.tsx` contains `hunterStep(`, `QuestionsForm`, `RunDriver`, `HunterReviewCard` and does not contain `PlanCard` or `Conversation`; `HunterReviewCard.tsx` does not contain `approveResearch`.
  - `nav.test.ts`: `/agentes/pesquisa/<setup run> opens the agent instead; answers refresh the agent chat` — `pesquisa/[id]/page.tsx` contains `run.setup_agent_id` and `` redirect(`/agentes/${run.setup_agent_id}`) ``; in `agentes/actions.ts` the bodies of `answerQuestions` and `adjustResearch` contain `revalidatePath("/agentes", "layout")`.
- [ ] Step 2: Run both files → FAIL.
- [ ] Step 3: Implement:
  - `finishHunter`: role → `getAgent` (null or other workspace → `not_found`) → already not `draft` → `{ ok: true }` → parse finish (`invalid` + `fieldErrors`) → parse `agent.config` with `hunterSetupSchema` (fail → `generic`) → `getSetupRun`; not `status === "plan" && plan` → `not_ready` → `updateAgent` as in the test.
  - `agentes/[id]/page.tsx` (`requireSender()`, uuid check → `notFound()`): loads agent + setup run (agent missing → `notFound()`; archived → `redirect("/agentes")`); `step = hunterStep(agent, run, hasAi())`. Always first: a user bubble with the 3 answers (audience, region, profile source). Then by step: `thinking`/`planning` → `<RunDriver>` (+ `t.research.conversation.thinking`/`planning`); `no_ai` → `t.ai.notConfigured` + `t.agents.hunter.noAi`; `questions` → the AI's "understood" line + `<QuestionsForm>` (as `Conversation` renders it); `choose` → `<HunterReviewCard>`; `setup_failed` → `t.agents.hunter.setupFailed` + "Recomeçar" (`restartHunterAction`); `created` → `<AgentDetail>`. Mount `RunDriver` only when `hasAi() && run && needsAdvance(run)`.
  - `HunterReviewCard` (client): stage "pick" = plan summary and places, plan warnings, q5 rigor (`DarkChoice` × `RIGORS`, help text, default `run.rigor`), q6 frequency (× `SCHEDULES`, default `weekly`), name input (default `defaultName`, max 80), "Ajustar o plano" textarea → `adjustResearch(run.id, text)`, button "Revisar →"; stage "review" = the 6.4 card with the Global Constraints rows, `review.paused`, `Voltar` (back to "pick") and `Criar agente (pausado)` → `finishHunterAction`, both disabled while pending; errors in `role="alert"`.
  - `AgentDetail`: name, type, status badge, the same summary rows read from `config` (+ schedule), "Custo da criação (IA)" = `usd(setupRun.spent_cost_usd)`, a disabled "Ligar" with `t.agents.detail.turnOnSoon`, `ArchiveButton`.
  - `pesquisa/[id]/page.tsx`: after loading the run, `if (run.setup_agent_id) redirect(`/agentes/${run.setup_agent_id}`)`.
  - README (Portuguese): AGENTES → "+ Novo agente" → Caçador; the agent is born pausado and does not run yet (rodar sozinho = próxima fase); the closer sees only LEADS; 0008 must be applied before deploying this code.
- [ ] Step 4: Run both files → PASS.
- [ ] Step 5: Checkpoint, full: `npm run check` → typecheck, lint, 753 passed | 3 todo, build, bundle check green; the build's route list adds `/agentes/novo` and `/agentes/[id]`, and still has every F1 route. Browser check: NOT possible against the real Supabase until 0008 is applied (C9); write "NOT browser-checked (0008 not applied)" in the ledger.

---

## Manual checklist (after the plan, with Juan)
- [ ] Claude checks which migrations the real Supabase has (C9) and, with Juan's OK, applies `0008_agents.sql` (needs 0001-0004; 0005-0007 not required by 0008). Then deploys the code.
- [ ] Juan, at 1280 px and 390 px: AGENTES → "+ Novo agente" → Caçador → answers → review card → "Criar agente (pausado)" → the agent is in "Meus agentes" as **pausado**; no search starts; no horizontal scroll at 390 px.

## Fora da F2
- Ligar / Pausar / Retomar, cron route, `next_run_at`, `agent_runs`, only-new companies, stale proof, AI ceiling pause, max 3 active Caçadores (C4-C7), run metrics (executions, found, verified, discarded) → F3.
- Unified LEADS, old research shown as "pesquisa avulsa" in the Caçador's history (C1), closer seeing only her assigned leads, tighter RLS on research/e-mail tables for the closer → F3/F5.
- Agente E-mail (creation, J1 approval, sending) → F4. Agente Ligação and the closer's own login/invites/role screen → F5. Ligação por IA stays off.
- q1 option "Um site" (needs an AI step that reads a website), ready-made niche templates, Duplicar, editing or renaming an agent after creation.
- Visual of `kolmeia/design-telas/Main.dc.html`; warnings strip in CAMPANHAS (F4).
- Applying 0008 to the real Supabase (manual checklist).
