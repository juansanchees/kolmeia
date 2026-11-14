# F3a LEADS unificados Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LEADS shows every company the workspace's searches found, one row per company (no repeats), with proof and "prova velha"; Juan's old searches are already there as "Pesquisa avulsa" (C1); the closer sees only leads assigned to her and can no longer touch research.
**Architecture:** Migration 0009 adds a workspace-level `leads` table fed by the database itself: when a research candidate is verified, a trigger links it to an existing lead of the workspace (same name key, website domain or last 10 phone digits, the `lib/research/dedupe.ts` rule, re-implemented in SQL and pinned to the TS by shared vectors) or creates one. Old verified candidates are back-filled once. Proof stays in `research_checks`/`research_evidence`; the lead shows the proof of all its candidates. The LEADS screen reads `leads` + the best candidate (newest verification). No AI, no background work: F3b (`2026-11-14-f3b-cacador-segundo-plano.md`) builds the background Caçador on top of this table.
**Tech Stack:** Next.js 16.4.5 App Router, React 19.3, Tailwind 4, TypeScript, zod 4, Supabase/Postgres (PGlite in tests), vitest (node env, no DOM).
**Spec:** `kolmeia/docs/superpowers/specs/2026-11-14-kolmeia-3-areas-design.md` — sections 5.3, 7.1, 7.2, 10 (row F3), decisions C1, C2 (status lives on the lead), C4 (prova velha), C8, C9, J2. Carries F2 blocker 4 and the "closer bounce" minor from `kolmeia/.superpowers/sdd/f2/progress.md`.

`APP` = `kolmeia/app`. Every command runs from `APP` unless it starts with `cd`.

## Global Constraints
- F3 is split in two plans. F3a (this) = unified LEADS + migration of old searches + closer RLS. F3b = Caçador in the background, only-new, AI ceiling, max 3, baseline report. F3's "pronto quando" is met only after F3b.
- Pre-flight (C9, manual, before Task 1 is applied anywhere real, not before coding): see "Manual checklist". Code and tests never touch the real Supabase: DB tests use `tests/db/helpers.ts` (PGlite, real migrations).
- Lead rule (decided here, spec 11 left it to the builder): a candidate becomes (or joins) a lead when `verified_at` goes from null to a value, or is inserted already verified. Unverified candidates (partial runs) are not leads. `best_candidate_id` = the most recently verified candidate of the lead. A refuted company is still a lead (so it is not "found again"), but only shows in the "Todos" tab, exactly like `inTab` does today.
- Duplicate key (spec 7.1): same `name_key` OR same `company_domain_key(website)` OR same `company_phone_key(phone)` as any candidate already linked to a lead of the same workspace. Priority when several leads match: name, then domain, then phone; ties → oldest lead. SQL `company_domain_key` = `public.url_host(website)` with the same shared-host list as `SHARED_HOSTS` in `dedupe.ts` (null for those hosts and their subdomains); `company_phone_key` = last 10 digits when there are ≥ 10, else null.
- Lead statuses (C8, spec 7.2; names decided here): `new | call_list | in_campaign | replied | with_closer | meeting | won | lost | discarded`, default `new`. In F3a nothing changes a status (no Descartar/Passar/Pôr em campanha yet: F4/F5 own them together with the send gates of C2/C3). Clients get SELECT only on `leads`.
- Origin (CLAUDE.md `origem` field, C1): `origin_kind 'agent' | 'one_off'`, `origin_agent_id`, `origin_run_id` = the first run that found the company. Old searches and every run without `agent_id` = `one_off`, shown as "Pesquisa avulsa".
- Prova velha (C4): evidence or "achada em" with `seen_at` more than 90 days before now → tag "prova velha". Reconferir stays a manual action: no button, only the hint copy.
- Closer (J2, F2 blocker 4): research tables are owner/sdr only for every write and for reading runs, sources, jobs and lists. Candidates, checks and evidence are readable by the closer only when they belong to a lead whose `owner_id` is her. `leads` select = sender OR `owner_id = auth.uid()`. Nothing in F3a assigns `owner_id` (that is "Passar pra closer", F5), so the closer sees an empty LEADS with her own empty-state copy.
- Migration `supabase/migrations/0009_leads.sql`: re-runnable style of 0001-0008 (`if not exists`, `drop policy if exists`, revoke-then-grant, `security definer` + `set search_path = ''`, fully qualified names). Depends on 0001-0008. Applying it to the real Supabase is the manual checklist, never a task. Deploy order: 0009 first, then the code.
- Copy: Brazilian Portuguese, short; identifiers English; never "pearchat" in `src`. New file `src/messages/pt/leads.ts` exports `leads` (spread in `index.ts` as `t.leads`; remove `leads` from `areas.ts`, drop `soon`, `none`, `start`). Fixed strings (verbatim):
  - `title: "Leads"`, `subtitle: "Todas as empresas que os agentes e as pesquisas acharam, sem repetir, com prova."`, `nav` unchanged.
  - `filters: { search: "Buscar empresa, cidade ou telefone", temperature: "Temperatura", agent: "Agente", status: "Status", all: "Todos" }`, `oneOff: "Pesquisa avulsa"`.
  - `statuses: { new: "novo", call_list: "na lista de ligação", in_campaign: "em campanha", replied: "respondeu", with_closer: "com a closer", meeting: "reunião", won: "ganho", lost: "perdido", discarded: "descartado" }`.
  - `columns: { company: "Empresa", temperature: "Temp.", approach: "Abordagem", status: "Status", proof: "Prova", agent: "Agente" }`, `proofCount: "{n} ✓"`, `csv: "Baixar CSV"`.
  - `stale: "prova velha"`, `staleHint: "Prova com mais de 90 dias: reconfira antes de usar."`.
  - `empty: "Nenhum lead ainda."`, `emptyCta: "Criar um Caçador"` (owner/sdr only, links `/agentes/novo`), `emptyCloser: "Nenhum lead passado para você ainda."`.
  - Detail: `seenIn: "Vista em {n} busca(s)"`, `firstSeen: "Primeira vez: {date}"`, `proofTitle: "Provas"`; field labels reuse `t.research.labels`/`t.research.sheet`.
- Reuse, do not fork: `CandidateRow`, `CANDIDATE_COLUMNS`, `normalizeCandidate`, `CheckWithEvidence`, `SHEET_COLUMNS`, `TABS`/`inTab`/`byTemperature`, `toCsv`/`csvCell`, `nameKey`/`domainKey`/`phoneKey`, `when`/`date` formatters, `Notice`.
- Next 16 differs from training data (`APP/AGENTS.md`): before Task 4 read `node_modules/next/dist/docs/` on dynamic route params (`params` is a Promise) and `notFound`.
- Git: `kolmeia/` is a public repo. One commit per task (message given in the task, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never commit `.env*`, keys, real leads, gold lists or reports. No push/deploy steps (the controller pushes). SDD ledger in `kolmeia/.superpowers/sdd/f3a/progress.md` (local only).
- Baseline (14/11/2026, after F2): `npx vitest run` → 756 passed | 3 todo, 30 files.

## Review Focus
1. **The same company written differently** ("Acme Builders, Inc." vs "ACME BUILDERS", `https://www.acme.com/contact` vs `http://acme.com`, "+1 (508) 555-0199" vs "508.555.0199") shows twice in LEADS. Expect one lead. Owners: Task 1 (`G9 same company across runs is one lead…`, `SQL company keys match lib/research/dedupe.ts on the shared vectors`).
2. **Two different companies sharing a Facebook/Yelp page or a 7-digit phone** get merged into one lead. Expect two leads. Owner: Task 1 (`shared hosts and short phones never merge companies`).
3. **Deleting an old search** (the run has a delete grant) leaves LEADS rows with no data or pointing at a deleted candidate. Expect the lead to fall back to its other candidate, or disappear. Owner: Task 1 (`deleting a search re-points or removes its leads`).
4. **The closer opens a research URL or calls an RPC directly** (`/agentes/pesquisa/<id>`, `claim_research_step`, `add_research_check`, an update of `answers`) and sees or changes searches. Expect nothing visible, nothing changed. Owners: Task 2 (`J2 the closer cannot start, answer, approve or advance research`), Task 4 (`agentes/pesquisa` is sender-only).
5. **Proof older than 90 days shown as fresh**, or a broken `seen_at` crashing the page. Expect "prova velha" past 90 days and no tag for a bad date. Owner: Task 3 (`isStaleProof: more than 90 days is stale; a bad date is not`).

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/supabase/migrations/0009_leads.sql` (T1, T2) | `research_runs.agent_id`, company key functions + candidate key columns, `leads`, link/relink triggers, back-fill (C1), leads RLS (T1); closer tightening on research tables (T2) |
| `APP/tests/fixtures/company-key-vectors.ts` (T1) | shared website/phone vectors for SQL ↔ TS parity |
| `APP/tests/db/leads.test.ts` (T1, T2) | DB rules above |
| `APP/src/lib/leads/types.ts` (T3) | `LEAD_STATUSES`, `LeadRow`, `LeadListItem`, `LeadDetail` |
| `APP/src/lib/leads/view.ts` (T3) | client-safe: filters, origin label, stale proof, proof count, CSV |
| `APP/src/lib/leads/queries.ts` (T3) | server-only reads of `leads` (session client, RLS applies) |
| `APP/src/messages/pt/leads.ts`, `areas.ts`, `index.ts` (T3) | copy |
| `APP/tests/unit/leads.test.ts` (T3) | view rules |
| `APP/src/components/research/proof.tsx` (T4) | `ProofList` + `Hook`, moved out of `Results.tsx`, with the stale tag |
| `APP/src/components/leads/LeadsTable.tsx` (T4) | filters, tabs, rows, CSV |
| `APP/src/app/(app)/leads/{page,layout}.tsx`, `leads/[id]/page.tsx` (T4) | list, detail |
| `APP/src/app/(app)/agentes/pesquisa/layout.tsx` (T4) | `requireSender()` |
| `APP/tests/unit/nav.test.ts` (T4), `APP/README.md` (T4) | source scans; Portuguese notes |

---

### Task 1: Migration 0009 — leads, duplicate key in SQL, back-fill of old searches

**Files:** Create `supabase/migrations/0009_leads.sql`, `tests/fixtures/company-key-vectors.ts`, `tests/db/leads.test.ts`.
**Interfaces:** Produces:
- `research_runs.agent_id uuid references public.agents (id) on delete set null` (no client grant; F3b writes it) + index `(agent_id, created_at desc)`.
- `public.company_domain_key(website text) returns text` and `public.company_phone_key(phone text) returns text` (both `immutable`, granted to `authenticated`).
- `research_candidates.domain_key` / `phone_key` (`generated always as (…) stored`), `research_candidates.lead_id uuid references public.leads (id) on delete set null` (no client grant); indexes `(workspace_id, name_key)`, `(workspace_id, domain_key) where domain_key is not null`, `(workspace_id, phone_key) where phone_key is not null`, `(lead_id)`.
- Table `public.leads`: `id uuid pk default gen_random_uuid()`, `workspace_id uuid not null → workspaces on delete cascade`, `best_candidate_id uuid → research_candidates on delete set null deferrable initially deferred`, `status text not null default 'new'` check in the 9 statuses, `origin_kind text not null` check in `('agent','one_off')`, `origin_agent_id uuid → agents on delete set null`, `origin_run_id uuid → research_runs on delete set null`, `owner_id uuid → auth.users on delete set null`, `first_seen_at`, `last_seen_at`, `created_at`, `updated_at timestamptz not null default now()`; index `(workspace_id, last_seen_at desc)`.
- `public.link_lead(p_ws uuid, p_run uuid, p_candidate uuid, p_name_key text, p_website text, p_phone text) returns uuid` (security definer, no client grant): takes `pg_advisory_xact_lock(hashtext('lead:' || p_ws::text))`, finds the lead by the Global Constraints key and priority among candidates with `lead_id is not null` of that workspace (excluding `p_candidate`), else inserts one with the run's origin (`agent_id` not null → `'agent'`); sets `best_candidate_id = p_candidate`, `last_seen_at = now()`; returns the lead id.
- Trigger `link_candidate_lead` BEFORE INSERT OR UPDATE OF `verified_at` on `research_candidates` (security definer function), when `new.verified_at is not null and (tg_op = 'INSERT' or old.verified_at is null)` → `new.lead_id := public.link_lead(…new values…)`.
- Trigger `unlink_candidate_lead` AFTER DELETE on `research_candidates` when `old.lead_id is not null` → best := newest-verified remaining candidate of that lead; none left → delete the lead.
- `public.backfill_leads() returns integer` (no client grant): every verified candidate with `lead_id is null`, ordered by `verified_at, created_at`, goes through `link_lead`; returns the count. The migration ends with `select public.backfill_leads();` (C1).
- RLS on `leads` enabled + forced; `grant select` only; policy `leads_select to authenticated using (public.is_workspace_sender(workspace_id) or owner_id = auth.uid())`.

- [ ] Step 1: Baseline: `npx vitest run` → 756 passed | 3 todo. Create the SDD ledger.
- [ ] Step 2: Write `tests/fixtures/company-key-vectors.ts`: `export const WEBSITE_VECTORS: string[]` (at least: `https://www.acme.com/contact`, `http://ACME.com`, `https://acme.com.`, `https://facebook.com/acme`, `https://m.facebook.com/acme`, `https://acme.wixsite.com/site`, `ftp://acme.com`, `not a url`, `""`) and `export const PHONE_VECTORS: string[]` (`+1 (508) 555-0199`, `508.555.0199`, `15085550199`, `555-0199`, `""`).
- [ ] Step 3: Write `tests/db/leads.test.ts` (setup like `agents.test.ts`: owner A + wsA, owner B + wsB, `UUID_C` sdr and `UUID_D` closer of wsA; helpers `run(user, ws)` and `cand(user, ws, run, {name, website?, phone?})` insert as the user with `name_key = nameKey(name)` from `@/lib/research/dedupe`; `verify(user, id)` sets `verified_at = now()`). `describe("0009 leads")`:
  - `leads: RLS on and forced; clients cannot insert, update or delete; anon has nothing`.
  - `a verified candidate becomes a lead stamped with its origin; an unverified one does not` — after `verify`: 1 lead, `status 'new'`, `origin_kind 'one_off'`, `origin_run_id` = run, `best_candidate_id` = candidate, candidate `lead_id` set; an unverified candidate → still 1 lead; a run whose `agent_id` was set by `db.admin` (agent inserted by admin) → its lead has `origin_kind 'agent'` and that `origin_agent_id`.
  - `G9 same company across runs is one lead: name key, website domain or last 10 phone digits` — run1 "Acme Builders, Inc." `https://www.acme.com/contact`; run2 "ACME BUILDERS" (no site) → same lead, `best` = run2's; run3 "Acme Construction Group" `http://acme.com` → same lead; run4 "Totally Other LLC" phone `508.555.0199` when run1's phone is `+1 (508) 555-0199` → same lead; total leads = 1; `origin_run_id` still run1.
  - `shared hosts and short phones never merge companies` — two names with `https://facebook.com/a` and `https://m.facebook.com/b` → 2 leads; two names with phone `555-0199` → 2 leads.
  - `SQL company keys match lib/research/dedupe.ts on the shared vectors` — for every vector, `select public.company_domain_key($1)` equals `domainKey(v)` and `public.company_phone_key($1)` equals `phoneKey(v)` (empty string vs null: both null). The TS functions are the reference: when a vector differs, change the SQL, never `dedupe.ts`.
  - `C1 old verified candidates are back-filled as "pesquisa avulsa"; the newest verification is the best; running it again changes nothing` — as admin: disable `link_candidate_lead`, insert two verified candidates of one company in run1 (older `verified_at`) and run2, enable; `select public.backfill_leads()` → 2; 1 lead, `origin_kind 'one_off'`, `origin_run_id` run1, best = run2's; second call → 0, still 1 lead.
  - `deleting a search re-points or removes its leads` — lead with candidates in run1 and run2 (best run2); owner deletes run2 → best = run1's; deletes run1 → 0 leads.
  - `R8 leads of another workspace are invisible` — B selects 0 of wsA's leads.
  - `agent_id and lead_id are the database's: clients cannot write them` — owner insert into `research_runs (…, agent_id)` → error 42501; update `research_candidates set lead_id` → 42501.
- [ ] Step 4: Run `npx vitest run tests/db/leads.test.ts` → FAIL (`relation "public.leads" does not exist`).
- [ ] Step 5: Write `0009_leads.sql` per Interfaces (functions first, then columns, table, triggers, RLS, revokes, back-fill call last).
- [ ] Step 6: Run the file → PASS. Run `npx vitest run` → 765 passed | 3 todo (no existing DB test changes).
- [ ] Step 7: Commit: `git add app/supabase/migrations/0009_leads.sql app/tests/fixtures/company-key-vectors.ts app/tests/db/leads.test.ts && git commit -m "feat(db): 0009 leads table with SQL dedupe and back-fill of old searches"` (+ Co-Authored-By line).

### Task 2: Migration 0009 — the closer leaves research (J2, F2 blocker 4)

**Files:** Modify `supabase/migrations/0009_leads.sql` (append a section), `tests/db/leads.test.ts`.
**Interfaces:** Produces `public.candidate_visible_to_assignee(p_candidate uuid) returns boolean` and `public.check_visible_to_assignee(p_check uuid) returns boolean` (security definer, stable, granted to `authenticated`: true when the candidate (or the check's candidate) has a `lead_id` whose lead has `owner_id = auth.uid()`). Recreated policies (names as in 0002/0004): `research_runs` select/insert/update → `is_workspace_sender(workspace_id)`, delete → `is_workspace_owner(workspace_id) or (created_by = auth.uid() and is_workspace_sender(workspace_id))`; `research_sources`, `research_jobs`, `research_lists`, `research_list_items` → every policy `is_workspace_sender` (insert checks keep `run_in_workspace`); `research_candidates` select → sender OR `candidate_visible_to_assignee(id)`, insert/update → sender; `research_checks` select → sender OR `candidate_visible_to_assignee(candidate_id)`, insert → sender; `research_evidence` select → sender OR `check_visible_to_assignee(check_id)`, insert → sender. `claim_research_step`, `release_research_step`, `add_research_check` re-created with `is_workspace_sender` in place of `is_workspace_member` (bodies otherwise unchanged).

- [ ] Step 1: Add `describe("0009 closer")` to `tests/db/leads.test.ts` (one verified lead in wsA with checks + evidence added through `add_research_check` by A):
  - `J2 the closer cannot start, answer, approve or advance research` — D: insert `research_runs` → error; update `answers` → 0 rows; `claim_research_step` → false or error; `add_research_check` on A's candidate → error; update `research_candidates.user_decision` → 0 rows.
  - `J2 the closer sees no research runs, sources, jobs or lists` — each count 0 for D.
  - `J2 the closer sees only the leads assigned to her, and their proof` — D sees 0 leads, 0 candidates; admin sets `owner_id = D` on the lead → D sees 1 lead, its candidate(s), their checks and evidence; a second, unassigned lead's candidate stays invisible.
  - `owner and sdr keep full research access` — C (sdr) inserts a run, updates `answers`, claims and releases the step, adds a check.
- [ ] Step 2: Run the file → the 4 new tests FAIL.
- [ ] Step 3: Append the section per Interfaces.
- [ ] Step 4: Run the file → PASS. Run `npx vitest run` → 769 passed | 3 todo; `research-rls.test.ts`, `email-rls.test.ts`, `agents.test.ts` unchanged and green.
- [ ] Step 5: Commit `feat(db): research tables are owner/sdr only; the closer sees only her assigned leads' proof`.

### Task 3: Leads vocabulary, view rules, reads, copy

**Files:** Create `src/lib/leads/{types,view,queries}.ts`, `src/messages/pt/leads.ts`, `tests/unit/leads.test.ts`. Modify `src/messages/pt/{areas,index}.ts`.
**Interfaces:**
- `types.ts`: `LEAD_STATUSES` (the 9, `as const`), `LeadStatus`; `LeadRow = { id; workspace_id; best_candidate_id: string | null; status: LeadStatus; origin_kind: "agent" | "one_off"; origin_agent_id: string | null; origin_run_id: string | null; owner_id: string | null; first_seen_at; last_seen_at }`; `LEAD_COLUMNS` string; `LeadListItem = { lead: LeadRow; best: CandidateRow; agentName: string | null; proofOk: number }`; `LeadDetail = { lead: LeadRow; agentName: string | null; candidates: (CandidateRow & { run_title: string; run_created_at: string })[]; checks: CheckWithEvidence[] }`.
- `view.ts` (client-safe): `STALE_PROOF_DAYS = 90`; `isStaleProof(seenAt: string | null | undefined, now: Date): boolean`; `proofCount(checks: Pick<CheckWithEvidence, "result" | "evidence">[]): number` (checks with `result === "ok"` and ≥ 1 evidence); `type LeadTab = Exclude<Tab, "jobs">`; `type LeadFilters = { q: string; temperature: Temperature | "all"; agent: "all" | "one_off" | string; status: LeadStatus | "all"; tab: LeadTab }`; `DEFAULT_LEAD_FILTERS: LeadFilters` (`tab: "all"`, rest `"all"`/`""`); `filterLeads(items: LeadListItem[], f: LeadFilters): LeadListItem[]` (search over best `name`, `city`, `phone` digits, case/accents ignored; `agent` matches `origin_agent_id`, `"one_off"` matches `origin_kind`; tab via `inTab(best, tab)`; sorted `byTemperature` on `best`); `originLabel(i: Pick<LeadListItem, "lead" | "agentName">): string` (`agentName` when present, else `t.leads.oneOff`); `leadsCsv(items: LeadListItem[]): string` (= `toCsv` over the bests with `SHEET_COLUMNS` plus two columns `Status`, `Agente`).
- `queries.ts` (`import "server-only"`): `listLeads(db: SupabaseClient, workspaceId: string): Promise<LeadListItem[]>` (leads with `best_candidate_id` not null, newest `last_seen_at` first, limit 500; bests via one `research_candidates … in (ids)` select; agent names via one `agents` select — empty for the closer, so `originLabel` falls back; `proofOk` via one `research_checks` select of the bests with embedded evidence); `getLead(db: SupabaseClient, id: string): Promise<LeadDetail | null>` (candidates `where lead_id = id` newest first with their run's `title`, `created_at`; checks of those candidates with evidence).

- [ ] Step 1: Failing tests in `tests/unit/leads.test.ts` (`describe("F3a leads")`, a `cand(overrides)` builder returning a full `CandidateRow`):
  - `isStaleProof: more than 90 days is stale; a bad date is not` — now `2026-11-14T12:00Z`: `2026-08-15T11:00Z` (91 days) → true; `2026-08-16T12:00Z` (90 days) → false; `"x"`, `null` → false.
  - `proofCount counts ok checks that carry evidence` — `[ok+1 ev, ok+0 ev, no+1 ev, unknown]` → 1.
  - `filterLeads: search matches name, city and phone, ignoring case and accents` — "acme" finds "ACME Builders"; "falmouth" finds city "Falmouth"; "5085550199" finds phone "+1 (508) 555-0199"; "são" finds "Sao Construction".
  - `filterLeads: temperature, agent, "Pesquisa avulsa", status and tab; hottest first` — fixtures across all filters; `tab "call"` excludes a refuted candidate, `"all"` keeps it; output order very_hot, hot, warm, cold.
  - `originLabel: the agent's name, or "Pesquisa avulsa"` — agent lead with name → name; agent lead with `agentName: null` (closer view) → `"Pesquisa avulsa"`; one-off → `"Pesquisa avulsa"`.
  - `leadsCsv: the research columns plus Status and Agente` — header row ends `Status,Agente`; 2 items → 2 data rows; status cell `"novo"`.
- [ ] Step 2: Run `npx vitest run tests/unit/leads.test.ts` → FAIL (modules missing).
- [ ] Step 3: Implement per Interfaces; copy per Global Constraints (`areas.ts` keeps `settings` only; `index.ts` spreads `leads`). `leads/page.tsx` still reads `t.leads.soon/none/start`: keep those three keys until Task 4 deletes them.
- [ ] Step 4: Run the file → PASS.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 775 passed | 3 todo.
- [ ] Step 6: Commit `feat(leads): lead vocabulary, filters, stale proof, CSV and reads`.

### Task 4: The LEADS screen, lead detail, closer bounce fixes, README, full check

**Files:** Create `src/components/research/proof.tsx`, `src/components/leads/LeadsTable.tsx`, `src/app/(app)/leads/[id]/page.tsx`. Modify `src/components/research/Results.tsx` (import `ProofList`, `Hook` from `./proof`), `src/app/(app)/leads/{page,layout}.tsx`, `src/app/(app)/agentes/pesquisa/layout.tsx`, `src/messages/pt/leads.ts` (drop `soon`, `none`, `start`), `tests/unit/nav.test.ts`, `README.md`.
**Interfaces:**
- Consumes Task 3 (`listLeads`, `getLead`, `filterLeads`, `DEFAULT_LEAD_FILTERS`, `originLabel`, `proofCount`, `isStaleProof`, `leadsCsv`, `LeadListItem`, `LeadDetail`), `isSender`, `requireSender`.
- Produces `ProofList({ c, checks, now }: { c: CandidateRow; checks: CheckWithEvidence[]; now: Date })` (unchanged markup + `t.leads.stale` tag next to "visto em" when `isStaleProof(seen_at, now)`), `Hook({ text })`; `LeadsTable({ items, canCreate }: { items: LeadListItem[]; canCreate: boolean })`.

- [ ] Step 1: Failing tests in `tests/unit/nav.test.ts` (`describe("F3a LEADS")`):
  - `LEADS lists leads, not searches` — `leads/page.tsx` contains `listLeads(` and not `research_runs`; `leads/[id]/page.tsx` contains `getLead(`, a uuid regex and `notFound()`.
  - `the closer is not sent to agent screens from LEADS` — `LeadsTable.tsx` renders the `/agentes/novo` link only under `canCreate`; `leads/page.tsx` passes `canCreate={isSender(`; `SENDER_ONLY` += `src/app/(app)/agentes/pesquisa/layout.tsx` (contains `requireSender()`).
  - `the proof list is shared and marks stale proof` — `proof.tsx` exports `ProofList` and contains `isStaleProof(`; `Results.tsx` imports from `"./proof"` and no longer declares `function ProofList`.
  - `the old LEADS placeholder is gone` — no file under `src` contains `t.leads.soon`, `t.leads.none` or `t.leads.start`.
- [ ] Step 2: Run `npx vitest run tests/unit/nav.test.ts` → FAIL.
- [ ] Step 3: Implement:
  - `leads/page.tsx` (server): `getCurrentWorkspace()` + session client → `listLeads` → `<LeadsTable items canCreate={isSender(workspace.role)} />`.
  - `LeadsTable` (client): filter bar of spec 5.3 (search input, selects Temperatura / Agente / Status built from the items), tab row (`TABS` minus `jobs`, labels from `t.research` tabs, counts), list rows `Empresa · Temp. · Abordagem · Status · Prova · Agente` (each row links `/leads/<id>`; stacked at 390 px, no horizontal scroll), "Baixar CSV" downloads `leadsCsv(filtered)` as `leads-<yyyy-mm-dd>.csv`. Empty: `emptyCloser` when `!canCreate`, else `empty` + `emptyCta`.
  - `leads/[id]/page.tsx` (server): uuid check → `notFound()`; `getLead` null → `notFound()`. Shows the best candidate: name, temperature, approach, status, origin, `firstSeen`; `Hook` when `hook`; perguntar por (name, title, confidence, source link); phone (+ source, or the existing "não verificado" copy); alvarás (count, total, last, biggest job); note. Then `proofTitle` + `seenIn`: for each candidate (newest first) the run title + date and `<ProofList c checks now>`; `staleHint` once when any proof is stale. Read-only (no action buttons in F3a).
  - `leads/layout.tsx`: subtitle from `t.leads.subtitle`; closer notice unchanged.
  - `agentes/pesquisa/layout.tsx`: `await requireSender()` first.
  - README (Portuguese): LEADS = todas as empresas, sem repetir; pesquisas antigas viraram "Pesquisa avulsa"; "prova velha" depois de 90 dias; a closer só vê leads passados para ela (chega na F5); aplicar 0009 antes do código.
- [ ] Step 4: Run `nav.test.ts` → PASS.
- [ ] Step 5: Checkpoint, full: `npm run check` → typecheck, lint, 779 passed | 3 todo, build, bundle check green; the build's route list adds `/leads/[id]` and keeps every F1/F2 route. Browser check is NOT possible until 0009 is applied (C9): write "NOT browser-checked (0009 not applied)" in the ledger.
- [ ] Step 6: Commit `feat(leads): unified LEADS list and lead detail with proof; research pages sender-only`.

---

## Manual checklist (after the plan, with Juan)
- [ ] C9 pre-check (Claude, read-only, in the Supabase SQL editor or MCP with Juan's OK): `select to_regclass('public.scheduler_state') s5, to_regclass('public.email_send_log') s3, to_regprocedure('public.scheduler_authorized()') f5, to_regclass('public.agents') s8;` plus, for 0006/0007, the objects their headers name. Record which of 0005-0008 exist. 0009 needs 0001-0008 applied in order.
- [ ] With Juan's OK, apply any missing 0005-0008, then `0009_leads.sql`. Then `select count(*) from public.leads;` > 0 if there were verified searches (C1 back-fill). Then deploy the code.
- [ ] Juan, at 1280 px and 390 px: LEADS shows his old companies once each, tagged "Pesquisa avulsa"; filters and CSV work; a lead opens with proof; no horizontal scroll at 390 px.

## Fora da F3a
- Caçador in the background, cron route, Ligar/Pausar, only-new companies, AI ceiling pause, max 3, baseline report → F3b.
- Lead actions: Descartar and Pôr em campanha (with the C2/C3 send gates) → F4; Passar pra closer (`owner_id`, `closer_brief`, `handed_off_at` on the lead), lista de ligação, call log → F5. Status changes of any kind.
- A "reconferir" button for stale proof; re-linking a lead when a verified candidate's website/phone changes later; merging two leads by hand.
- E-mail RLS for the closer (`email_prospects`, `/leads/closer`) → F5.
