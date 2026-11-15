# F5 Ligação manual + login da closer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner invites a closer by link; she signs in with her own login and sees only the leads handed or assigned to her; Juan hands any lead to her from LEADS ("Passar pra closer", with the brief, even for a lead that never got an e-mail); an "Ligação" agent builds the daily call list; the closer opens a lead, taps the number, records the result in under 1 minute, and the lead's status changes by itself (meeting, lost, do-not-call); won/lost are set by hand; owner/sdr see a funnel by origin.
**Architecture:** One migration, `0020_calls_closer.sql`, written in two serial tasks. Part A: `workspace_invites` (hashed one-use token, 7 days, bound to an e-mail; no e-mail is sent by the app), `accept_workspace_invite`, `list_workspace_people`, freeing a removed member's leads, and new lead columns + `hand_off_lead` / `set_lead_status`. Part B: `call_logs` (+ `log_call`, the outcome → status rule, `do_not_call` that also stops active e-mail prospects), the `call` agent type allowed through `guard_agent`, `call_list_items` built per agent per New York day by `build_call_list` (eligibility in one SQL function, `lead_callable`). The closer keeps the RLS she already has (`leads.owner_id = auth.uid()` drives leads, fields, candidates, checks, evidence): building a list or handing off assigns `owner_id`. Screens: Configurações → Equipe + `/convite/[token]`; LEADS → lead page actions, "Com a closer" on leads, "Ligar" (list + call screen), "Funil".
**Tech Stack:** Next.js 16.4.5 App Router, React 19.3 (controlled forms), TypeScript, zod 4, Supabase/Postgres with forced RLS (PGlite in tests), vitest (node env, no DOM).
**Spec:** `kolmeia/docs/superpowers/specs/2026-11-14-kolmeia-3-areas-design.md` — §5.1 (closer sees only LEADS), §5.3 (lead actions), §6.1/§6.3/§6.6 (agent Ligação, its 3 questions, its metrics), §7.2 (statuses, C2, C8), §7.3 (C13), §7.4 (call record), §9 (compliance), §10 row F5, §11 (roles and closer RLS); decisions J2, C2, C8, C10, C11, C13.

`APP` = `kolmeia/app`. Every command runs from `APP` unless it starts with `cd`.

## Global Constraints
- Branch base: F3d-2's migration `0016_*.sql` (contact scraper) and the security-fix round's `0017`-`0019` must be merged first. F5's migration is `supabase/migrations/0020_calls_closer.sql`. There is no `0012` on this branch: never reference it. Before Task 1, open `0016_*.sql`-`0019_*.sql` and check whether they redefine `guard_agent`, `link_lead`, `lead_visible_to_assignee`, `hand_off_prospect` or the `leads` policies; if one does, start from the newest version (**confirmar após 0016-0019**). Baseline: Task 1 Step 1 records `npx vitest run` as `B`.
- Pronto quando (spec §10 F5): the closer signs in with her own login, sees only her leads, calls, records the result in under 1 minute per call (?) and the lead status changes.
- Role helper (**confirmar após 0017-0019**): the fix round adds closer-scoped RLS on `email_prospects`/`email_messages`/`email_replies` and possibly a role-check helper (e.g. `workspace_role_of(ws)` or `is_workspace_closer(ws)`). Reuse the fix-round helper if present, else create `public.is_workspace_closer(ws uuid) returns boolean` (security definer, `set search_path = ''`, same style as `is_workspace_sender`) in 0020. Never add a second helper with the same meaning.
- Roles (J2, already in 0001 as `workspace_role` enum `owner|sdr|closer`; `is_workspace_sender` = owner/sdr from 0003): owner invites/removes members; owner/sdr hand off, create call agents, set won/lost on any lead, see Funil; closer: reads only `leads.owner_id = auth.uid()` (existing 0009/0011 policies, unchanged), logs calls and sets won/lost only on those, sees "Ligar" for lists where she is the caller; never sees AGENTES, CAMPANHAS, Equipe, Funil, Cobertura.
- Invite (decided, no e-mail from the app): owner creates an invite for `{ name ≤ 80, email, role 'closer' }` → the app shows a link `/convite/<token>` once; Juan sends it himself (WhatsApp). Token = 64 hex chars from two `gen_random_uuid()` without dashes; stored only as `sha256` hex; expires 7 days; one use; revocable. Accept needs a signed-in user whose `auth.users.email` equals the invite e-mail (lower-case) and who belongs to no workspace yet (C11: no workspace picker) → member row with the invite's role. Sign-up keeps today's flow: Supabase sends its own confirmation e-mail (existing behavior, not new).
- Lead status values (0009, unchanged): `new, call_list, in_campaign, replied, with_closer, meeting, won, lost, discarded`. New columns on `leads`: `handed_off_at timestamptz`, `handed_off_by uuid → auth.users on delete set null`, `closer_brief jsonb check (public.is_closer_brief(closer_brief))`, `do_not_call boolean not null default false`, `do_not_call_at timestamptz`.
- Call outcomes (spec §7.4, verbatim): `no_answer, voicemail, gatekeeper, talked, meeting_booked, not_interested, wrong_number, do_not_call`. "Atendeu" (spec §6.6 metric) = `gatekeeper, talked, meeting_booked, not_interested, do_not_call`.
- Status after a call (decided; same table in SQL `lead_status_after_call` and TS `statusAfterCall`, pinned by `tests/fixtures/call-status-vectors.ts`): `won` and `discarded` never change; `meeting_booked` → `meeting`; `not_interested` → `lost` (?); `do_not_call` → `lost` (?) + `do_not_call = true`; any other outcome → `call_list` when the status was `new`, else unchanged.
- `do_not_call` (C2): blocks every future call list and `log_call` refuses nothing (a last call can still be recorded), but `lead_callable` is false forever; active `email_prospects` of the lead's candidates become `stopped` with `stop_reason 'asked_to_stop'` and `cancel_pending_steps(id, 'do_not_call')`. F4's send gates must also read `leads.do_not_call` (note in README; no F4 code here).
- `recorded`: column `recorded boolean not null default false check (recorded = false)`; no recording UI, no field, no upload, no audio (MA all-party consent, spec §9). No SMS anywhere (no `sms:` link). No AI voice. No AI call at all in F5 (Gastos unchanged).
- Call list eligibility `lead_callable(p_lead uuid, p_caller uuid) returns boolean` (decided): not `do_not_call`; status in (`new`, `call_list`); `lead_phone(p_lead)` not null; not in an active campaign (`lead_in_active_campaign(p_lead)` = status `in_campaign` or an `email_prospects` row `status = 'active'` whose candidate's `lead_id` is the lead — the hook F4 extends); `owner_id` null or `p_caller`; no `call_logs` row for the lead on today's `call_day()`; the newest call is not `wrong_number` with the same `company_phone_key` as today's phone; the newest call's `next_step_at` is null or ≤ now.
- `lead_phone(p_lead) returns text`: the best candidate's `phone` when `company_phone_key` is not null, else the newest non-refuted `lead_fields` `phone` with a key; else null.
- `call_day() returns date` = `(now() at time zone 'America/New_York')::date`.
- List order (decided): callbacks due first (newest call has `next_step_at ≤ now`), then best-candidate temperature `very_hot, hot, warm, cold, null`, then `level desc`, then `first_seen_at`, then `id`.
- Call agent config (spec §6.3 questions "filtro / quantos por dia / quem liga"; keys exact, unknown key → refused): `{ caller_id: uuid (member of the workspace, any role), per_day: 1..50 (default 20), min_level: 0..4 (default 1), temperatures: Temperature[] (⊆ very_hot,hot,warm,cold; [] = any, and only [] lets a lead without temperature in) }`. Born `draft`; `draft → paused` when `call_agent_config_ok(config, ws)`; then only Ligar/Pausar; config frozen (A6). No `agent_runs`, no clock: lists are built on demand.
- Closer brief on a lead (C13, no AI): same shape as today (`is_closer_brief`: `who ≤ 600, what_they_said ≤ 800, next_step ≤ 400, evidence_urls ≤ 4 safe, model ≤ 60`), `model = "manual"`. Prefill: an `email_prospects.closer_brief` of the lead's candidates (newest) when one exists; else `who` = ask-for name/title + company, `what_they_said` = newest `talked` call's notes, else `t.handoff.noTalkYet`; `evidence_urls` = first 4 safe URLs of the lead's proof. Juan edits `next_step` (required).
- Copy (pt-BR, short, never "pearchat"). New files, registered in `src/messages/pt/index.ts` in Tasks 1/2; a later task adds keys only to its own file. Verbatim: `t.team = { tab: "Equipe", invite: "Convidar closer", name: "Nome", email: "E-mail", link: "Link do convite (vale 7 dias, 1 uso):", copy: "Copiar link", sendYourself: "A Kolmeia não manda e-mail. Mande o link você mesmo.", revoke: "Cancelar convite", remove: "Remover", roles: { owner: "dono", sdr: "SDR", closer: "closer" }, accept: "Entrar na equipe", signInFirst: "Entre ou crie sua conta com {email} para aceitar.", wrongEmail: "Este convite é para outro e-mail.", hasWorkspace: "Esta conta já tem um workspace. Use outro e-mail.", expired: "Convite vencido ou já usado." }`; `t.handoff = { button: "Passar pra closer", to: "Para quem", who: "Quem", said: "O que disse", next: "Próximo passo", proof: "Provas", noTalkYet: "Ainda sem conversa.", noCloser: "Nenhuma closer na equipe. Convide em Configurações → Equipe.", done: "Passado para {name}.", won: "Ganho", lost: "Perdido", addToList: "Pôr na lista de ligação" }`; `t.calls = { tab: "Ligar", today: "Lista de hoje", empty: "Nada para ligar hoje.", call: "Ligar", outcome: "Resultado", outcomes: { no_answer: "Não atendeu", voicemail: "Caixa postal", gatekeeper: "Recepção", talked: "Falou", meeting_booked: "Reunião marcada", not_interested: "Sem interesse", wrong_number: "Número errado", do_not_call: "Não ligar mais" }, spokeTo: "Falou com (nome/cargo)", notes: "Nota", nextStep: "Próximo passo", nextAt: "Quando", save: "Salvar e próximo", statusWillBe: "Status vira: {status}", noRecording: "Sem gravação: em MA gravar exige o OK de todos.", b2bOnly: "Só empresas. Número residencial: checar a lista Do Not Call antes.", history: "Ligações", done: "Feitas hoje" }`; `t.callAgent = { create: "Criar", caller: "Quem liga", perDay: "Quantos por dia", minLevel: "Nível mínimo", temperatures: "Temperatura", any: "Qualquer", build: "Montar lista de hoje", metrics: { inList: "na lista", called: "ligados", answered: "atendeu", meetings: "reunião marcada" } }`; `t.funnel = { tab: "Funil", origin: "Origem", total: "Total" }`.
- Reuse, do not fork: `is_closer_brief`, `parseCloserBrief`, `cancel_pending_steps`, `company_phone_key`, `is_workspace_sender`, `requireSender`, `getCurrentWorkspace`, `listLeads`/`getLead`/`displayOf`/`originLabel`, `SubNav`, `Notice`, `Badge`, `btn` (orange `cta` = only "Passar pra closer"), `Field`/`TextInput`/`TextArea`, `ActionButton`, `date`, `FormState`, `guard_agent` (re-created from 0010's body plus the call rules, nothing removed).
- Next 16 (`APP/AGENTS.md`): before Tasks 3-6 read `node_modules/next/dist/docs/` on `params`/`searchParams` (Promises) and server actions.
- Git: one commit per task, message given, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit real names, e-mails, phones or tokens; fixtures use `*.example` and `508-555-01xx`. No push/deploy. SDD ledger `kolmeia/.superpowers/sdd/f5/progress.md`.
- Parallelism: Task 1 → Task 2 (same migration and shared files) run in series. After Task 2, Tasks 3, 4, 5, 6 and 7 touch disjoint files and may run in parallel; Task 7's final `npm run check` runs last.

## Review Focus
1. **A closer reading leads that are not hers** through a side door: a call list of someone else's agent, `call_list_items` of another caller, `call_logs` of other leads, `list_workspace_people`, the funnel. Expect nothing beyond her own leads and her own list rows. Owners: Task 2 (`the closer reads only her list rows and the calls of her leads`), Task 1 (`people list and invites are owner/sdr only`).
2. **An invite link forwarded to someone else, reused, or opened by a user who already has a workspace.** Expect refusal with `wrongEmail` / `expired` / `hasWorkspace`, and no member row. Owner: Task 1 (`accept: same e-mail, once, before expiry, only for a user without a workspace`).
3. **Two people building the same list at once, or the list re-built after calls** (page refresh by the closer while Juan presses "Montar lista"). Expect no duplicate rows, never more than `per_day` items per agent per day, and called leads not replaced by new ones the same day. Owner: Task 2 (`build is idempotent per day and never passes per_day`).
4. **A lead flagged do-not-call or with a wrong number coming back** the next day, through another agent, through "Pôr na lista de ligação", or in an active e-mail campaign. Expect it never listed again (wrong number: until the phone changes) and its active prospects stopped. Owner: Task 2 (`do_not_call blocks every future list, the manual add, and stops active prospects`; `wrong number comes back only with a new phone`).
5. **Removing the closer from the team** while leads are assigned to her. Expect her leads back to unassigned (`owner_id` null, status unchanged) and her running call agents paused. Owner: Task 1 (`removing a member frees her leads`), Task 2 (`… and pauses the call agents she was the caller of`).

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/supabase/migrations/0020_calls_closer.sql` part A, `tests/db/team.test.ts`, `tests/db/helpers.ts`, `src/lib/team/types.ts`, `src/lib/leads/types.ts`, `src/messages/pt/{team,handoff}.ts`, `src/lib/nav.ts` (T1) | invites, people, hand-off, won/lost |
| `0020_calls_closer.sql` part B, `tests/db/calls.test.ts`, `tests/fixtures/call-status-vectors.ts`, `src/lib/calls/{types,view}.ts`, `src/messages/pt/{calls,callAgent,funnel}.ts`, `src/lib/nav.ts`, `tests/unit/nav.test.ts` (T2) | calls, call agent, daily list |
| `src/app/(app)/configuracoes/equipe/*`, `src/app/convite/[token]/*`, `src/app/login/*`, `src/components/team/*` (T3) | Equipe + accept |
| `src/app/(app)/leads/[id]/page.tsx`, `src/app/(app)/leads/lead-actions.ts`, `src/app/(app)/leads/closer/page.tsx`, `src/lib/leads/brief.ts`, `src/components/leads/{HandOffForm,StatusButtons,AddToCallList}.tsx` (T4) | Passar pra closer, won/lost, Com a closer |
| `src/components/agents/{AgentGallery,CallAgentForm,CallAgentDetail}.tsx`, `src/app/(app)/agentes/call-actions.ts`, `src/app/(app)/agentes/[id]/page.tsx`, `src/lib/agents/view.ts`, `src/lib/calls/list-queries.ts`, `src/app/(app)/leads/ligar/page.tsx` (T5) | agent Ligação + today's list |
| `src/app/(app)/leads/ligar/[id]/{page.tsx,actions.ts}`, `src/components/calls/{CallForm,CallFacts,CallHistory}.tsx`, `src/lib/calls/call-queries.ts` (T6) | call screen |
| `src/lib/leads/funnel.ts`, `src/app/(app)/leads/funil/page.tsx`, `README.md` (T7) | funnel by origin, docs, final check |

---

### Task 1: Migration 0020 part A — invites, people, hand-off, won/lost

**Files:** Create `supabase/migrations/0020_calls_closer.sql` (part A), `tests/db/team.test.ts`, `src/lib/team/types.ts`, `src/messages/pt/{team,handoff}.ts`. Modify `tests/db/helpers.ts` (`auth.users` gets `email text`; `addUser(id: string, ai = true, email?: string)`), `src/lib/leads/types.ts` (`LeadRow` + `handed_off_at`, `handed_off_by`, `closer_brief: unknown`, `do_not_call: boolean`, `do_not_call_at`; `LEAD_COLUMNS` lists them), `src/messages/pt/index.ts`, `src/lib/nav.ts`.
**Interfaces:**
- `workspace_invites (id uuid pk, workspace_id → workspaces cascade, name text 1..80, email text (lower, is_email_address), role workspace_role not null check (role = 'closer'), token_hash text unique not null, expires_at timestamptz not null, created_by (stamped), created_at, accepted_by uuid → auth.users on delete set null, accepted_at, revoked_at)`. RLS select: `is_workspace_owner(workspace_id)`; no client writes; `token_hash` never selected (column grant excludes it).
- RPCs (`security definer`, `set search_path = ''`, authenticated): `create_workspace_invite(p_ws uuid, p_name text, p_email text) returns text` (owner only else 42501; returns the plain token once); `revoke_workspace_invite(p_invite uuid) returns void` (owner); `invite_preview(p_token text) returns table (workspace_name text, email text, valid boolean)` (any signed-in user; no other columns); `accept_workspace_invite(p_token text) returns uuid` (workspace id; errors: `P0001 'expired'`, `'wrong_email'`, `'has_workspace'` as the message, mapped by Task 3); `list_workspace_people(p_ws uuid) returns table (user_id uuid, role workspace_role, label text)` (sender only; label = accepted invite `name`, else `role`).
- Trigger `release_member_leads` AFTER DELETE on `workspace_members`: `update leads set owner_id = null where workspace_id = old.workspace_id and owner_id = old.user_id` (Task 2 adds the call-agent pause to the same function).
- Lead columns per Global Constraints. `hand_off_lead(p_lead uuid, p_closer uuid, p_brief jsonb) returns void`: sender of the lead's workspace else 42501; `p_closer` a `closer` member of that workspace (role helper per Global Constraints) else 22023; `p_brief` passes `is_closer_brief` and is not null else 22023; status `won|lost|discarded` → 55000; sets `owner_id`, `status = case when status = 'meeting' then 'meeting' else 'with_closer' end`, `handed_off_at = now()`, `handed_off_by = auth.uid()`, `closer_brief`, `updated_at`. Re-hand-off to another closer allowed.
- `set_lead_status(p_lead uuid, p_status text) returns void`: `p_status in ('won','lost')` else 22023; sender, or `owner_id = auth.uid()`, else 42501; from `discarded` → 55000.
- `src/lib/team/types.ts`: `type Person = { user_id: string; role: Role; label: string }`; `type InviteRow = { id; name; email; role: "closer"; expires_at; accepted_at: string | null; revoked_at: string | null; created_at }`; `INVITE_COLUMNS`.
- `nav.ts`: `settingsTabsFor(role)` adds `{ href: "/configuracoes/equipe", label: t.team.tab }` for `owner` only.

- [ ] Step 1: Baseline `npx vitest run` → record `B`. Create the ledger. Read `0016_*.sql`-`0019_*.sql` (Global Constraints check: redefined functions, the fix-round role helper).
- [ ] Step 2: Write `tests/db/team.test.ts` (users with e-mails `closer@a.example`, workspace A owner/sdr, workspace B owner):
  - `only the owner creates and revokes invites; the token is returned once and stored hashed` — sdr/closer → 42501; `select token_hash` as owner → permission denied; the stored hash = `encode(sha256(token::bytea),'hex')`.
  - `accept: same e-mail, once, before expiry, only for a user without a workspace` — wrong e-mail → `wrong_email`; second accept → `expired`; `expires_at` moved to the past → `expired`; revoked → `expired`; a user who owns workspace B → `has_workspace`; success → member row role `closer`.
  - `people list and invites are owner/sdr only` — closer calls `list_workspace_people` → 42501; another workspace's owner → 42501; label = invite name.
  - `hand-off: owner/sdr to a closer of the same workspace, brief required and checked; status with_closer, or meeting kept` — to an sdr or a closer of B → 22023; brief with a `javascript:` URL → 22023; won lead → 55000; the closer then selects the lead and its candidate/evidence (existing policies).
  - `won/lost by a sender or the assigned closer only` — another closer → 42501; `discarded` → 55000; `p_status 'meeting'` → 22023.
  - `removing a member frees her leads` — owner deletes the closer's member row → her leads have `owner_id` null, status unchanged.
- [ ] Step 3: Run `npx vitest run tests/db/team.test.ts` → FAIL.
- [ ] Step 4: Write part A of `0020_calls_closer.sql` (re-runnable, header listing T-A1..T-A6 like 0009's), update `helpers.ts`, `types.ts`, messages, `nav.ts`.
- [ ] Step 5: Run → PASS; `npx vitest run` → `B + 6`, every older file green (`leads.test.ts`, `email-rls.test.ts`).
- [ ] Step 6: Commit `feat(db): 0020 part A closer invites by link, people list, lead hand-off and won/lost`.

### Task 2: Migration 0020 part B — call log, call agent, daily list

**Files:** Modify `supabase/migrations/0020_calls_closer.sql` (append part B), `src/lib/nav.ts`, `src/messages/pt/index.ts`, `tests/unit/nav.test.ts` (the test `the LEADS tabs are Todos and Com a closer` becomes the one below). Create `tests/db/calls.test.ts`, `tests/fixtures/call-status-vectors.ts`, `src/lib/calls/{types,view}.ts`, `src/messages/pt/{calls,callAgent,funnel}.ts`, `tests/unit/calls-view.test.ts`.
**Interfaces:**
- `call_logs (id uuid pk, workspace_id → workspaces cascade, lead_id uuid not null, (lead_id, workspace_id) → leads (id, workspace_id) on delete cascade, agent_id → agents on delete set null, called_by uuid → auth.users on delete set null, called_at timestamptz not null default now(), phone_used text not null, outcome text not null check in (§7.4 list), spoke_to text ≤ 120 default '', notes text ≤ 500 default '', next_step text ≤ 200 default '', next_step_at timestamptz, recorded boolean not null default false check (recorded = false), created_at)`; index `(lead_id, called_at desc)`. RLS select: `is_workspace_sender(workspace_id) or lead_visible_to_assignee(lead_id, workspace_id)`; no client writes.
- `log_call(p_lead uuid, p_agent uuid, p_outcome text, p_spoke_to text, p_notes text, p_next_step text, p_next_step_at timestamptz) returns text` (the new lead status): sender or lead owner else 42501; `p_agent` null or a `call` agent of the workspace; `phone_used = lead_phone(p_lead)` (null → 55000 `'no phone'`); `next_step_at` within now−1 day .. now+180 days else 22023; applies `lead_status_after_call(status, outcome)`; `do_not_call` effects per Global Constraints; per-lead advisory lock.
- `lead_status_after_call(p_status text, p_outcome text) returns text` (immutable), `lead_phone(p_lead uuid) returns text`, `lead_in_active_campaign(p_lead uuid) returns boolean`, `lead_callable(p_lead uuid, p_caller uuid) returns boolean`, `call_day() returns date`, `call_agent_config_ok(p_config jsonb, p_ws uuid) returns boolean` — all internal (`security definer`, execute revoked from clients) except none.
- `guard_agent()` re-created from 0010 + for `type = 'call'`: `draft → paused` when `call_agent_config_ok(new.config, new.workspace_id)`; `paused ↔ running` allowed; nothing else new. Insert of `type = 'email'` still allowed as today (untouched).
- `call_list_items (id uuid pk, workspace_id, agent_id → agents cascade, lead_id (+ws) → leads cascade, caller_id uuid → auth.users cascade, list_date date not null, position integer not null, created_at, unique (agent_id, lead_id, list_date))`. RLS select: `is_workspace_sender(workspace_id) or caller_id = auth.uid()`; no client writes.
- `build_call_list(p_agent uuid) returns integer` (rows added): caller of the agent or sender, else 42501; agent `call`, `running`, not archived else 55000; per-workspace advisory lock; adds up to `per_day − (rows already today)` leads where `lead_callable(lead, caller)` and the config filters pass, in the list order; for each added lead `owner_id := caller` when null and `status := 'call_list'` when `new`. `build_my_call_lists() returns integer` = `build_call_list` over the running call agents whose `caller_id = auth.uid()`.
- `add_to_call_list(p_lead uuid, p_agent uuid) returns void`: sender only; `lead_callable(lead, agent caller)` else 55000; appends today at `max(position)+1` (not counted against `per_day`).
- `release_member_leads` also sets `status = 'paused'` on running `call` agents whose `config->>'caller_id'` is the removed user (as table owner; `guard_agent` allows it because `is_client_role()` is false).
- `src/lib/calls/types.ts` (client-safe): `CALL_OUTCOMES` (§7.4 order), `CallOutcome`, `ANSWERED: readonly CallOutcome[]`, `CallLogRow`, `CALL_LOG_COLUMNS`, `CallAgentConfig = { caller_id: string; per_day: number; min_level: number; temperatures: Temperature[] }`, `callAgentConfigSchema` (zod, strict, per Global Constraints), `CallListItemRow`.
- `src/lib/calls/view.ts` (client-safe): `statusAfterCall(status: LeadStatus, outcome: CallOutcome): LeadStatus`; `telHref(phone: string): string | null` (`tel:+1` + `company_phone_key` digits; null if fewer than 10); `callAgentMetrics(items: Pick<CallListItemRow,"lead_id">[], calls: Pick<CallLogRow,"lead_id"|"outcome">[]): { inList: number; called: number; answered: number; meetings: number }`.
- `nav.ts`: `leadsTabsFor(role)` = closer: Todos, Com a closer, Ligar `/leads/ligar`; owner/sdr: Todos, Com a closer, Ligar, Funil `/leads/funil`, Cobertura.

- [ ] Step 1: Write `tests/fixtures/call-status-vectors.ts` (`{ status, outcome, after }[]`, every outcome × `new, call_list, with_closer, meeting, won, lost, discarded`, values per Global Constraints).
- [ ] Step 2: Write `tests/db/calls.test.ts` (reuse Task 1's seeds; phones `508-555-0101`…):
  - `status after a call matches the shared vectors` (SQL `lead_status_after_call` over the fixture).
  - `log_call: sender or the assigned closer; phone_used comes from the lead; recorded is always false` — another closer → 42501; inserting `recorded = true` as admin → check violation; no phone → 55000; `next_step_at` a year away → 22023.
  - `do_not_call blocks every future list, the manual add, and stops active prospects` — lead `do_not_call`, status `lost`; an `active` prospect of its candidate → `stopped`/`asked_to_stop`, its draft steps cancelled; next day (`call_day` moved by setting `now` via a fixed `called_at`/list row date) not listed; `add_to_call_list` → 55000.
  - `wrong number comes back only with a new phone`.
  - `the call list: phone, not do_not_call, not in an active campaign, not called today, callbacks first, then temperature and level` — expected order on 6 seeded leads; a lead with an `active` prospect is out; `owner_id` of another user is out; listed leads get `owner_id` = caller and `new → call_list`.
  - `build is idempotent per day and never passes per_day` — two builds (sender then caller) → `per_day` rows; after 2 calls a rebuild adds 0.
  - `the closer reads only her list rows and the calls of her leads`.
  - `call agent: born draft, paused only with a valid config, then only Ligar/Pausar; config frozen; a running call agent is never picked by the hunter or sources clock` — bad `caller_id` (not a member), `per_day 0`, unknown key → stays draft; `hunter_due_work` / `source_enqueue_agent_runs` return nothing for it.
  - `removing a member frees her leads and pauses the call agents she was the caller of`.
- [ ] Step 3: Write `tests/unit/calls-view.test.ts`: `statusAfterCall matches the shared vectors`; `telHref builds tel:+1 and refuses short numbers`; `metrics count answered as gatekeeper, talked, meeting, not interested, do not call`. In `nav.test.ts`: `the LEADS tabs: Ligar for everyone, Funil and Cobertura for owner/sdr; Equipe only for the owner`.
- [ ] Step 4: Run both files → FAIL.
- [ ] Step 5: Append part B to `0020_calls_closer.sql`; write the lib files, messages, `nav.ts`.
- [ ] Step 6: Run → PASS; `npx vitest run` → `B + 18` (`hunter-*`, `sources-*`, `agents.test.ts` green).
- [ ] Step 7: Commit `feat(db): 0020 part B call log with status rules, call agent, daily call list`.

### Task 3: Equipe and the invite link (parallel with 4-7)

**Files:** Create `src/app/(app)/configuracoes/equipe/{page.tsx,actions.ts}`, `src/components/team/{InviteForm,PeopleList}.tsx`, `src/app/convite/[token]/{page.tsx,actions.ts}`, `tests/unit/team-flow.test.ts`. Modify `src/app/login/{actions.ts,LoginForm.tsx,page.tsx}`, `src/messages/pt/team.ts` (own keys only).
**Interfaces:**
- Consumes Task 1 RPCs and `t.team`.
- `equipe/actions.ts` (`"use server"`, owner only: `getCurrentWorkspace()` role `owner` else `redirect("/leads")`): `createInviteAction(prev: FormState, form: FormData): Promise<FormState & { link?: string }>` (zod name 1..80, email; link = `${origin}/convite/${token}` with origin from `headers()` host + proto); `revokeInviteAction(id: string): Promise<void>`; `removeMemberAction(userId: string): Promise<FormState>` (delete own row refused; last-owner error → message).
- `equipe/page.tsx` (owner only): `PeopleList` (label, role), pending invites with `revoke`, `InviteForm` (controlled; after success shows the link in a read-only input + `copy` button + `sendYourself`).
- `/convite/[token]` (outside `(app)`, like `/onboarding`; `dynamic = "force-dynamic"`): token must match `^[0-9a-f]{64}$` else 404; not signed in → `signInFirst` with a link `/login?next=/convite/<token>`; signed in → `invite_preview`; invalid → `expired`; valid → `accept` button → `acceptInviteAction(token: string): Promise<FormState>` → `redirect("/leads")`; RPC messages `wrong_email|has_workspace|expired` → `t.team.*`.
- `login`: `safeNext(raw: unknown): string` exported from `src/app/login/next.ts` (new, client-safe) — only `^/convite/[0-9a-f]{64}$` passes, else `"/"`; `authenticate` redirects to it; the form carries it in a hidden input from `searchParams.next`.

- [ ] Step 1: Write `tests/unit/team-flow.test.ts`:
  - `safeNext only lets an invite path through` — `"/convite/" + "a".repeat(64)` passes; `"//evil.example"`, `"/convite/../x"`, `"https://x.example"`, `"/leads"` → `"/"`.
  - `the invite never sends e-mail and the link is shown once` — `equipe/actions.ts` does not contain `inviteUserByEmail`, `nodemailer`, `sendMail`; `InviteForm.tsx` contains `sendYourself`.
  - `Equipe is owner-only` — `equipe/page.tsx` and `actions.ts` check role `owner`.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement per Interfaces.
- [ ] Step 4: Run → PASS; `npx tsc --noEmit && npm run lint` → 0 errors.
- [ ] Step 5: Commit `feat(team): invite a closer by link, accept with the same e-mail, team list`.

### Task 4: "Passar pra closer" in LEADS, won/lost, "Com a closer" on leads (parallel)

**Files:** Create `src/lib/leads/brief.ts`, `src/app/(app)/leads/lead-actions.ts`, `src/components/leads/{HandOffForm,StatusButtons,AddToCallList}.tsx`, `tests/unit/handoff.test.ts`. Modify `src/app/(app)/leads/[id]/page.tsx`, `src/app/(app)/leads/closer/page.tsx`, `src/lib/leads/queries.ts` (add `emailBriefOf(db, leadId): Promise<unknown | null>` — newest `email_prospects.closer_brief` of the lead's candidates), `src/messages/pt/handoff.ts` (own keys only).
**Interfaces:**
- Consumes `hand_off_lead`, `set_lead_status`, `add_to_call_list`, `list_workspace_people`, `t.handoff`, `parseCloserBrief`.
- `brief.ts` (client-safe): `draftBrief(input: { company: string; askForName: string | null; askForTitle: string | null; emailBrief: CloserBrief | null; talkedNotes: string | null; proofUrls: string[] }): Omit<CloserBrief, "model"> & { model: "manual" }` per Global Constraints (`evidence_urls` through `sanitizeUrl`, deduped, ≤ 4; strings cut to the SQL limits).
- `lead-actions.ts` (`"use server"`): `handOffLeadAction(leadId: string, closerId: string, brief: { who: string; what_they_said: string; next_step: string; evidence_urls: string[] }): Promise<FormState>` (`requireSender`; zod; `next_step` 1..400 required; `model: "manual"` added server-side); `setLeadStatusAction(leadId: string, status: "won" | "lost"): Promise<FormState>` (any signed-in member; RLS/RPC decides); `addToCallListAction(leadId: string, agentId: string): Promise<FormState>` (`requireSender`). Each `revalidatePath("/leads", "layout")`.
- `HandOffForm({ leadId, closers: Person[], draft })` (client, controlled): closer select (only `role === "closer"`; none → `noCloser` with link to Equipe), editable `who` / `what_they_said` / `next_step`, proof URLs listed read-only; submit button `btn.cta` with `t.handoff.button`.
- Lead page: for senders: `HandOffForm` (hidden when status `won|lost|discarded`), `AddToCallList` (select of running call agents; hidden when not callable per status/phone/do_not_call), `StatusButtons`; for the assigned closer: `StatusButtons` and a link "Ligar ▸" `/leads/ligar/<id>`; brief shown (parsed) when `closer_brief` is set; status + `do_not_call` badge.
- `/leads/closer`: first list = leads `status in ('with_closer','meeting')` with `owner_id` not null (RLS limits the closer to hers), newest `handed_off_at` first, each card with company, closer label (senders), brief, "Ligar ▸"; the old e-mail prospects section stays below for senders only (unchanged code).

- [ ] Step 1: Write `tests/unit/handoff.test.ts`:
  - `draftBrief uses the e-mail brief when there is one, else ask-for and call notes; at most 4 safe proof URLs; model manual`.
  - `a lead that never got an e-mail can be handed off` — `draftBrief` with `emailBrief: null, talkedNotes: null` → `what_they_said` = `t.handoff.noTalkYet`, valid against `parseCloserBrief`.
  - `only "Passar pra closer" is orange` — `HandOffForm.tsx` uses `btn.cta`; `StatusButtons.tsx` and `AddToCallList.tsx` do not.
  - `the hand-off action is sender-only and needs a next step` — `lead-actions.ts` contains `requireSender` inside `handOffLeadAction` and the `next_step` min 1.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement per Interfaces.
- [ ] Step 4: Run → PASS; `npx tsc --noEmit && npm run lint` → 0 errors.
- [ ] Step 5: Commit `feat(leads): pass any lead to the closer with a brief, won/lost, Com a closer lists leads`.

### Task 5: Agent "Ligação" and today's list (parallel)

**Files:** Create `src/components/agents/{CallAgentForm,CallAgentDetail}.tsx`, `src/app/(app)/agentes/call-actions.ts`, `src/lib/calls/list-queries.ts`, `src/app/(app)/leads/ligar/page.tsx`, `tests/unit/call-agent.test.ts`. Modify `src/components/agents/AgentGallery.tsx` (Ligação card active; "Ligação por IA · Em breve" stays off), `src/app/(app)/agentes/[id]/page.tsx` (type `call` → `CallAgentDetail`), `src/app/(app)/agentes/novo/page.tsx` (passes `people`), `src/lib/agents/view.ts` (`agentRowView` metric for `call` = `"{n} na lista"`), `src/messages/pt/callAgent.ts` (own keys only).
**Interfaces:**
- Consumes `callAgentConfigSchema`, `callAgentMetrics`, `build_call_list`, `build_my_call_lists`, `list_workspace_people`.
- `call-actions.ts` (`"use server"`, `requireSender`): `createCallAgentAction(input: { name: string; config: CallAgentConfig }): Promise<{ ok: true; agentId: string } | { ok: false; error: string }>` (insert `type 'call'`, then update `status 'paused'`; redirect handled by caller); `buildListAction(agentId: string): Promise<FormState>`; Ligar/Pausar reuse the existing agent power action if it is type-agnostic, else `setCallAgentRunningAction(agentId: string, on: boolean)` (**confirmar** in `agent-actions.ts`).
- `CallAgentForm({ people })` (client, controlled; spec §6.3 three questions in order): filter (min level 0-4, temperature checkboxes, `any`), `perDay` (number 1..50, default 20), `caller` (select of people); name default "Ligação diária".
- `list-queries.ts` (`server-only`): `todayList(db: SupabaseClient, opts: { agentId?: string }): Promise<{ item: CallListItemRow; lead: LeadListItem; lastCall: CallLogRow | null; calledToday: boolean }[]>` (rows of `call_day()` as returned by RLS, joined to `listLeads`-shaped display and the newest call); `agentCallStats(db, agentId): Promise<{ inList; called; answered; meetings }>` (today, via `callAgentMetrics`).
- `/leads/ligar` (any member): calls `build_my_call_lists` once on load (errors ignored, then read), shows `today`: rows with name, temperature, level, phone, "Ligar ▸" `/leads/ligar/<lead id>`; called rows move under `done` with their outcome; empty → `empty`. Senders also see a select of the workspace's call agents' lists (read only).
- `CallAgentDetail`: config summary (caller label, per day, filter), `build` button, metrics (`t.callAgent.metrics`), today's list (read-only).

- [ ] Step 1: Write `tests/unit/call-agent.test.ts`:
  - `the call agent config: defaults, ranges, unknown keys refused` (`callAgentConfigSchema`).
  - `the gallery creates Ligação and keeps AI calling off` — `AgentGallery.tsx` renders `CallAgentForm`; the text `aiCall`/`soon` still present for the AI card.
  - `the list page builds the caller's lists and reads only through RLS` — `leads/ligar/page.tsx` contains `build_my_call_lists` and no `service`/admin client.
  - `agentRowView shows the list size for a call agent`.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement per Interfaces.
- [ ] Step 4: Run → PASS; `npx tsc --noEmit && npm run lint` → 0 errors.
- [ ] Step 5: Commit `feat(calls): agent Ligação with filter, per-day count and caller; today's call list`.

### Task 6: The call screen — tap, record in under a minute (parallel)

**Files:** Create `src/app/(app)/leads/ligar/[id]/{page.tsx,actions.ts}`, `src/components/calls/{CallFacts,CallForm,CallHistory}.tsx`, `src/lib/calls/call-queries.ts`, `tests/unit/call-screen.test.ts`. Modify `src/messages/pt/calls.ts` (own keys only).
**Interfaces:**
- Consumes `log_call`, `statusAfterCall`, `telHref`, `CALL_OUTCOMES`, `getLead`, `displayOf`, `parseCloserBrief`.
- `call-queries.ts` (`server-only`): `callsOf(db, leadId): Promise<CallLogRow[]>` (newest first, ≤ 50); `nextInList(db, afterLeadId: string): Promise<string | null>` (next not-called row of today's lists visible to the user, by position).
- `ligar/[id]/page.tsx` (any member; RLS → 404 when not visible): `CallFacts` (name; big `tel:` link from `telHref`, text `call`; ask-for name/title; hook; city; level/temperature; closer brief when set; up to 4 proof URLs with excerpt and "prova velha" when > 90 days; `b2bOnly` and `noRecording` notices), `CallForm`, `CallHistory`. `do_not_call` lead → form hidden, notice shown.
- `CallForm({ leadId, agentId, status })` (client, controlled): 8 outcome buttons as a radio group (one tap), `spokeTo` (≤ 120), `notes` (≤ 500), `nextStep` (≤ 200) + `nextAt` (`datetime-local`, optional) + two chips "Amanhã 9h" / "Em 1 semana"; live line `statusWillBe` from `statusAfterCall`; submit `save`. No field named or about recording; no `sms:`.
- `actions.ts`: `logCallAction(input: { leadId: string; agentId: string | null; outcome: CallOutcome; spokeTo: string; notes: string; nextStep: string; nextAt: string | null }): Promise<FormState & { next?: string | null }>` (zod; `nextAt` parsed in America/New_York; calls `log_call`; returns `nextInList`; the form then `router.push` to it or to `/leads/ligar`).
- `CallHistory({ calls })`: date, outcome label, spoke to, notes, next step.

- [ ] Step 1: Write `tests/unit/call-screen.test.ts`:
  - `one tap picks the outcome; only the outcome is required` — `logCallAction` zod schema accepts `{ outcome: "no_answer" }` + ids with empty strings; refuses an unknown outcome and notes over 500.
  - `no recording, no SMS, no AI voice on the call screen` — `CallForm.tsx`, `CallFacts.tsx`, `page.tsx` contain no `record` input, no `sms:`, no `getUserMedia`, no `MediaRecorder`; `CallFacts.tsx` contains `noRecording` and `b2bOnly`.
  - `the number is a tel: link` — `CallFacts.tsx` uses `telHref`.
  - `the form shows the status the lead will get` — `CallForm.tsx` uses `statusAfterCall` and `statusWillBe`.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement per Interfaces.
- [ ] Step 4: Run → PASS; `npx tsc --noEmit && npm run lint` → 0 errors.
- [ ] Step 5: Commit `feat(calls): call screen with tel link, proof, one-tap outcome and status change`.

### Task 7: Funil by origin, README, full check (parallel; check last)

**Files:** Create `src/lib/leads/funnel.ts`, `src/app/(app)/leads/funil/page.tsx`, `tests/unit/funnel.test.ts`. Modify `README.md`, `src/messages/pt/funnel.ts` (own keys only).
**Interfaces:**
- `funnel.ts` (client-safe): `FUNNEL_STATUSES = ["new","call_list","in_campaign","replied","with_closer","meeting","won","lost"] as const` (discarded apart); `funnelByOrigin(items: Pick<LeadListItem,"lead"|"agentName"|"importName">[]): { origin: string; counts: Record<(typeof FUNNEL_STATUSES)[number] | "discarded", number>; total: number }[]` (origin = `originLabel`; sorted by total desc, then origin).
- `funil/page.tsx` (`requireSender`): table origins × statuses + totals row (C8), numbers only, from `listLeads`.

- [ ] Step 1: Write `tests/unit/funnel.test.ts`: `counts by origin and status, one row per origin, a totals row, discarded apart`; `Funil is sender-only` (`funil/page.tsx` contains `requireSender`).
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement. README (Portuguese): Equipe/convite por link (sem e-mail da Kolmeia; o Supabase manda o e-mail de confirmação do cadastro), Passar pra closer, agente Ligação e lista do dia, tela de ligação (sem gravação, sem SMS, B2B), regras de status, `do_not_call` (F4 deve conferir), Funil; aplicar 0020 antes do código.
- [ ] Step 4: After Tasks 3-6 are merged: `npm run check` → typecheck, lint, `B + 18 + (Tasks 3-7 tests)` all green, build, bundle check; routes add `/configuracoes/equipe`, `/convite/[token]`, `/leads/ligar`, `/leads/ligar/[id]`, `/leads/funil`.
- [ ] Step 5: Commit `feat(leads): funnel by origin; docs for F5`.

---

## External prerequisites
- 0016 (contact scraper) and the security-fix round (0017-0019) merged on the branch before Task 1.
- A second e-mail address for the closer test account (Juan's or the closer's real one; Juan decides who).

## Manual checklist (after the plan, with Juan)
- [ ] C9 (Claude, read-only): 0013-0019 applied on the real Supabase.
- [ ] With Juan's OK: apply `0020_calls_closer.sql`; deploy.
- [ ] Juan (owner): Configurações → Equipe → Convidar closer (name + e-mail) → copies the link and sends it himself.
- [ ] The closer opens the link, creates her account with that e-mail, confirms the Supabase e-mail, opens the link again, "Entrar na equipe" → she lands on LEADS with no leads, menu = LEADS only.
- [ ] Juan opens a lead that never got an e-mail → "Passar pra closer" → picks her, writes the next step → the closer refreshes and sees only that lead, with the brief and proof.
- [ ] Juan creates "Ligação diária" (filter level ≥ 1, 10 per day, caller = closer) → Ligar. The closer opens Ligar: ≤ 10 leads, each with a phone.
- [ ] The closer makes 3 real calls (B2B numbers only), timing each record: tap number → call → outcome → "Salvar e próximo" in < 1 min each (?). One `meeting_booked` → status "reunião"; one `not_interested` → "perdido"; `do_not_call` on a test lead → never listed again.
- [ ] Funil: counts by origin match LEADS.

## Fora da F5
- AI voice / outbound dialer / Twilio / Vapi (spec §2.2, §9); call recording of any kind; SMS.
- National Do Not Call registry lookup for residential numbers (today only the B2B notice; a "residencial?" flag per lead is not built) (?).
- Inviting SDRs or other owners, changing roles in the UI, a workspace picker (C11), invite e-mails sent by the app (Supabase `inviteUserByEmail`).
- Discarding a lead from LEADS, reopening a won/lost lead, editing or deleting a call record.
- The F4 campaign side of C2/C3 (send gates reading `leads.do_not_call`, "lead in one active campaign"); only the `lead_in_active_campaign` hook is here.
- Closer-scoped RLS on the e-mail tables: done by the security-fix round (0017-0019), not here.
- Calendar booking for `meeting_booked`, reminders/notifications for `next_step_at`.
