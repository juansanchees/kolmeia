# F4 Agente E-mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Juan creates an "E-mail" agent from LEADS: the AI writes a 1-3 step sequence, Juan sees it plus 3 example e-mails rendered for real leads (with the CAN-SPAM footer), approves once, and the agent then queues and sends the batch alone inside the E2/E3 gates; a discarded or `do_not_call` lead stops at once, a lead is in one active campaign only, and nothing goes out for real until the C12 checklist is recorded with Juan.
**Architecture:** First close E3 (Task 6 review, Task 7 README, final review). Then migrations 0021-0026 (0027 only if Juan says yes to D1): 0021 links `email_prospects` to `leads` with a sourced address and a `lead_campaign_locks` table whose primary key is the lead (C3); 0022 makes the lead status the truth (C2) inside the claim; 0023 adds versioned `email_sequences` with ONE SQL renderer, a 3-example preview, an owner approval tied to a digest of what was seen, and a queue function that stamps the R1 approval on each rendered message (J1); 0024 is E4 (mailbox health, ramp, emergency stop); 0025 lets the clock send real mail and 0026 lets it read replies (E5), both only when the fix-round C12 gate is open AND the env switch `SCHEDULER_REAL_SEND=1` is set. The AI writes a template with 3 merge fields (no AI per lead), one Sonnet call per click, charged to the clicking user's caps.
**Tech Stack:** Next.js 16.4.5 App Router, React 19.3 (controlled forms), TypeScript, zod 4, Supabase/Postgres (RLS forced, PGlite in tests), vitest (node env, no DOM).
**Spec:** `kolmeia/docs/superpowers/specs/2026-11-14-kolmeia-3-areas-design.md` — §6.1, §6.3 (E-mail chat), §6.5, §6.6, §7.2 (C2, C3), §8, §9, §10 row F4; decisions J1, C2, C3, C9, C12. Engine docs: `kolmeia/docs/engenharia-envio.html` §§05-07 (E4, E5, E6); E3 plan `2026-11-14-e3-rodizio-de-caixas.md` (Tasks 6-7); ledger `kolmeia/.superpowers/sdd/e3/progress.md`.

`APP` = `kolmeia/app`. Every command runs from `APP` unless it starts with `cd`.

## Global Constraints
- **Base branch:** branch `f4-agente-email` from the branch that holds 0016 (F3d-2), the security-fix round (0017-0019) and F5's 0020 (ask the coordinator which one). Names from them are marked **(confirmar após fix round)** / **(confirmar após F5)**: open the merged code first, adapt, never fork. Baseline: Task 1 Step 1 records `B` (`npx vitest run` passed | todo).
- **Migrations:** F4 owns `0021`-`0026` (`0027` only on D1 = yes). Never edit 0001-0020. Re-runnable style (`if not exists`, `drop ... if exists`, `create or replace`). Every new definer function: `security definer`, `set search_path = ''`, `revoke all ... from public, anon, authenticated`, then the one grant it needs; add each to the exact definer list in `tests/db/rls.test.ts`. A function re-created here (e.g. `claim_next_email_core`) is re-created from its NEWEST body (0007 or a fix-round migration, **confirmar após fix round**), same signature, same grants.
- **0012_auto_reply:** exists only as commit `50d7e54` on `f3c-1-lista` (`4676dff` on a worktree branch). Juan ordered: never apply it to any Supabase, never push without his request. F4 does NOT renumber it silently: it is decision **D1** and Task 13 runs only on his explicit yes. Until then no F4 file depends on it, and `f3c-1-lista` must not be merged with `50d7e54` in it.
- **No real sending in F4 (C12):** reuse the fix-round C12 gate (owner's checklist record for mailboxes, domain, SPF/DKIM/DMARC, warm-up, physical address), checked by `set_campaign_send_mode` and every send path. Its SQL predicate is called `send_checklist_ok(p_ws uuid) returns boolean` in this plan **(confirmar após fix round; use its real name)**. Do NOT design a second gate. F4 adds one more lock for the clock only: env `SCHEDULER_REAL_SEND` (absent by default; only `"1"` turns it on), read by `realClockEnabled(): boolean` in `src/lib/email/config.ts`. Both closed by default. No migration, test or seed opens the gate on a real database; no step sends real mail.
- **CAN-SPAM (§9):** every e-mail keeps `composeEmail`'s footer: `sender_name`, `legal_name`, `postal_address`, one-click unsubscribe (`List-Unsubscribe` + page). The AI never writes links or "unsubscribe" text (R12 stays). Per mailbox 30-50/day: `mailboxes.daily_limit` stays 1..50 (E2 cap 50/24 h); E4 ramp lowers it while warming. Separate prospecting domain = checklist item, not code. Never SMS.
- **J1 approval:** owner only (D3) approves a sequence version after the screen showed the steps and the 3 examples; `approve_email_sequence` checks a digest of exactly that. Any edit = new version `draft`, unsent messages back to `draft`. Follow-ups of an approved version need nothing more.
- **Merge fields (D2, values decided):** `{{first_name}}` = first word of `contact_name`, else `there`; `{{company}}` = `company_name`; `{{city}}` = the lead's non-refuted `city` field, else `your area`. Any other `{{...}}` is invalid (22023 in SQL, `unknown_var` in TS). One renderer in SQL (`render_email_template`); the TS `renderTemplate` exists only for the editor's live preview and is pinned to SQL by `tests/fixtures/template-vectors.ts`.
- **C2:** `lead_blocks_email(p_lead)` = lead exists and (`status = 'discarded'` or `do_not_call`). `leads.do_not_call` comes from F5's 0020 **(confirmar após F5)**; 0021 repeats `add column if not exists do_not_call boolean not null default false` so either order works.
- **C3:** `lead_campaign_locks.lead_id` is the primary key; a prospect holds the lock while `status = 'active'` and its campaign is not `done`/`archived`. A second campaign gets the prospect as `stopped`/`in_other_campaign` (insert) or 23505 (update to active).
- **AI (caps):** task `email_sequence`, `MODELS.sonnet`, effort medium, `maxTokens 6000`, no web tools, one call per click (“Escrever com IA” / “Reescrever”), through `sessionLedger` (user, global and workspace caps of `reserve_ai_call`; `ai_calls.run_id` null). Button shows `t.emailAgent.write` with `usd = reserveFor(sequenceDef)`. Gastos label "Agente E-mail". Lead data goes in as `untrusted("audience", …)`.
- **Copy:** Brazilian Portuguese, short, never "pearchat"; new `src/messages/pt/emailAgent.ts` (`t.emailAgent`). Verbatim: `title: "Agente E-mail"`, `waiting: "aguarda aprovação"`, `approved: "aprovada v{n}"`, `write: "Escrever com IA (estimativa US$ {usd})"`, `rewrite: "Reescrever"`, `saveEdit: "Salvar edição"`, `approve: "Aprovar sequência"`, `examples: "3 e-mails de exemplo (leads reais)"`, `onlyOwner: "Só o dono aprova."`, `editResets: "Editar volta para aguarda aprovação."`, `rehearsalOnly: "Envio real bloqueado até o checklist (C12)."`, `noEmail: "{n} sem e-mail"`, `otherCampaign: "{n} já em outra campanha"`, `blocked: "{n} descartados ou não contatar"`, `tones: { direct: "Direto", friendly: "Amigável", consultive: "Consultivo" }`, `stop: "Parar todos os envios"`.
- **Reuse, do not fork:** `runTask`, `reserveFor`, `untrusted`, `UNTRUSTED`, `sessionLedger`, `cleanDraftEmail`, `subjectProblem`/`bodyProblem`, `composeEmail`/`buildFooter`, `sendStep`, `runTick`, `NoSendSmtp`, `GmailSmtp`/`GmailImap`, `matchIncoming`/`isBounce`/`isAutoReply`, `listLeads`, `loadMailboxes`, `CampaignMailboxesForm`, `requireSender`, `SubNav`, `Notice`.
- **Next 16 (`APP/AGENTS.md`):** before Tasks 7-9 read `node_modules/next/dist/docs/` on server actions and `searchParams`.
- **Git:** public repo; one commit per task with the message given, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit real leads, addresses, DNS records or secrets. No push, no deploy, no `supabase db push`. SDD ledger `kolmeia/.superpowers/sdd/2026-11-15-f4-agente-email/progress.md`.

## Review Focus
1. **Juan edits the sequence (or two tabs approve) after the examples were shown.** Expect 40001 "sequence changed; review again", no message queued from text he did not see, and older approved-but-unsent messages back to `draft`. Owner: Task 5 (`the approval is tied to the digest the screen showed…`, `an edit after approval sends nothing from the old text…`).
2. **A lead is discarded or marked do_not_call while its message is already `approved` and due, or while the clock holds a claim.** Expect the claim to skip it, the prospect `stopped`, pending steps cancelled, nothing sent. Owner: Task 3 (`C2 a discarded lead's due message is never claimed…`, `do_not_call during a claim…`).
3. **The same company reached by two campaigns (two leads with the same domain, or one lead added twice).** Expect the lock to refuse the lead twice and E2's company rule to hold across campaigns. Owner: Task 2 (`C3 one active campaign per lead…`, `E2 one person per company holds across campaigns`).
4. **Lead text with links, `{{system}}` tokens or "ignore the rules" in the hook/note sent to the writer.** Expect untrusted wrapping, unknown placeholders rejected, no links in steps. Owner: Task 6 (`audience is untrusted…`, `a step with a link or unknown placeholder is dropped…`).
5. **Gate half-open: checklist recorded but env switch off, or env on but checklist missing, or `sending_paused` on.** Expect zero SMTP and IMAP calls from the clock in every half-open state. Owners: Task 11 (`no SMTP while any lock is closed`), Task 12 (`no IMAP while any lock is closed`).

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/README.md` (T1, T15) | E3 section; F4 section |
| `APP/supabase/migrations/0021_lead_campaigns.sql`, `tests/db/lead-campaigns.test.ts` (T2) | prospect↔lead, sourced address, C3 lock, `add_leads_to_campaign`, `lead_blocks_email` |
| `APP/supabase/migrations/0022_lead_gate.sql`, `tests/db/lead-gate.test.ts` (T3) | C2 trigger + claim |
| `APP/supabase/migrations/0023_email_sequences.sql`, `tests/db/email-sequences.test.ts`, `tests/fixtures/template-vectors.ts` (T4, T5) | sequences, renderer, preview, approval, queue, agent life cycle |
| `APP/src/lib/email/template.ts`, `src/lib/ai/prompts/email-sequence.ts`, `src/lib/ai/email-tasks.ts`, `tests/unit/email-sequence.test.ts` (T6) | template rules + AI writer |
| `APP/src/app/(app)/agentes/novo/email/{page.tsx,actions.ts}`, `src/components/agents/EmailAgentWizard.tsx`, `src/lib/email-agent/{types,queries}.ts`, `src/messages/pt/emailAgent.ts` (T7) | creation chat |
| `APP/src/components/agents/{EmailAgentDetail,SequenceEditor,SequenceExamples}.tsx`, `src/app/(app)/agentes/[id]/{page.tsx,email-actions.ts}` (T8) | review, approve, Ligar/Pausar, metrics |
| `APP/src/app/(app)/leads/[id]/…`, `src/components/leads/AddToCampaign.tsx` (T9) | "Pôr em campanha" |
| `APP/supabase/migrations/0024_mailbox_health.sql`, `tests/db/mailbox-health.test.ts`, caixas page (T10) | E4 |
| `APP/supabase/migrations/0025_clock_real.sql`, `src/lib/email/{scheduler,scheduler-store,config}.ts`, `src/app/api/scheduler/tick/route.ts`, `tests/engine/clock-real.test.ts` (T11) | clock real send behind both locks |
| `APP/supabase/migrations/0026_clock_replies.sql`, `src/lib/email/clock-replies.ts`, `tests/engine/clock-replies.test.ts` (T12) | E5 |
| `APP/supabase/migrations/0027_auto_reply.sql` (T13, only on D1 = yes) | 0012 content re-based |
| `APP/src/lib/email/warnings.ts`, `src/components/email/CampaignWarnings.tsx` (T14) | avisos |

Waves: T1 → {T2 ‖ T6} → T3 → {T4 → T5 ‖ T10} → {T7 → T8 ‖ T9} → T11 → T12 → (T13) → T14 → T15. `‖` = parallel (different files).

---

### Task 1: Close E3 (Task 6 review, Task 7 README, final review)

**Files:** Modify `README.md`; fixes only where the review finds them (E3 Task 6 files now live under `src/app/(app)/campanhas/` after F1: `campanhas/[id]/page.tsx`, `campanhas/actions.ts`, `campanhas/respostas/page.tsx`, `src/components/email/forms.tsx`, `src/lib/email/{engine,rotation,schedule,types}.ts`, `src/messages/pt/email.ts`, `tests/{engine/rotation,unit/email-rotation}.test.ts`).
**Interfaces:** none new. Reviewer input: `kolmeia/.superpowers/sdd/e3/task-6-diff.txt`, `task-6-report.md`, and the same code in git (it entered with commit `626bc54`).

- [ ] Step 1: `npx vitest run` → record `B`. Create the ledger.
- [ ] Step 2: Dispatch the E3 Task 6 reviewer (spec = E3 plan Task 6 + carry-overs in `e3/progress.md` Task 5 line) on the current files, not the snapshot. Known concerns to rule on: removing the first mailbox in real mode sends the campaign back to rehearsal; remove-then-insert is not atomic; page not browser-checked.
- [ ] Step 3: Fix Important findings test-first in the named files only.
- [ ] Step 4: E3 Task 7: `grep -n "Rodízio de caixas (E3)" README.md` → no output; add the E3 section verbatim from the E3 plan (§ "Rodízio de caixas (E3)"), with the migration list updated to what is in the repo; re-grep → found.
- [ ] Step 5: Whole-E3 review (0007 + engine + page) by one fresh reviewer; record the verdict in `e3/progress.md` ("E3 DONE").
- [ ] Step 6: `npm run check` → green, `B` (+ any fix tests).
- [ ] Step 7: Commit `docs(email): close E3 (rotation README, Task 6 review fixes)`.

### Task 2: Migration 0021 — leads into campaigns, sourced address, one active campaign per lead (C3)

**Files:** Create `supabase/migrations/0021_lead_campaigns.sql`, `tests/db/lead-campaigns.test.ts`. Modify `src/lib/email/types.ts` (`ProspectRow.lead_id`, `email_source` += `"lead"`, `email_source_ref`, both in `PROSPECT_COLUMNS`), `tests/db/email-rls.test.ts` (`TABLES` += `lead_campaign_locks`), `tests/db/rls.test.ts` (definer list).
**Interfaces:**
- `email_prospects.lead_id uuid` with FK `(lead_id, workspace_id) → leads (id, workspace_id) on delete set null (lead_id)` (0011 pattern); back-fill from `research_candidates.lead_id` via `candidate_id`. `email_prospects.email_source_ref text` (≤ 2000) = `"<lead_fields.source>:<source_ref or field id>"`. `email_source` check += `'lead'`; R18 re-created adding `or (email is not null and email_source = 'lead' and email_source_ref is not null)`. `stop_reason` check += `'in_other_campaign', 'lead_discarded', 'do_not_call'`.
- `leads.do_not_call boolean not null default false` (add if not exists; F5 owns the UI). `lead_blocks_email(p_lead uuid) returns boolean` (stable, plain, internal).
- `lead_campaign_locks (lead_id uuid primary key references leads on delete cascade, workspace_id, campaign_id → email_campaigns on delete cascade, prospect_id → email_prospects on delete cascade unique, locked_at)`; RLS select sender; no client writes.
- Trigger `guard_prospect_lead` BEFORE INSERT OR UPDATE OF status, lead_id ON email_prospects: lead locked by another prospect → on insert `status := 'stopped'`, `stop_reason := 'in_other_campaign'`; on update to `active` → raise `C3: lead already in an active campaign` (23505). Trigger `sync_lead_lock` AFTER INSERT/UPDATE/DELETE: take or drop the lock per C3; on take, lead `new|call_list` → `in_campaign`; prospect → `replied` moves lead `new|call_list|in_campaign` → `replied` (forward only). Trigger on `email_campaigns` status → `done|archived` drops its locks; leaving them re-takes locks, conflicting prospects → `stopped`/`in_other_campaign`.
- `add_leads_to_campaign(p_campaign uuid, p_leads uuid[]) returns jsonb` (definer, sender of the campaign's workspace, ≤ 500 ids else 22023, campaign not archived): per lead: blocked (`lead_blocks_email`) → `blocked`; locked elsewhere → `in_other_campaign`; already a prospect → `already`; no non-refuted `email` field → `no_email`; suppressed → `suppressed`; else insert prospect (company = lead `name` field else best candidate name; contact from `contact_name`/`contact_title` fields; email = `confirmed` first, then newest `seen_at`; `email_source 'lead'`). Returns `{added, no_email, blocked, in_other_campaign, suppressed, already}`. Calls `queue_approved_sequence` when 0023 exists (Task 5 adds that call by re-creating this function).

- [ ] Step 1: Write `tests/db/lead-campaigns.test.ts`:
  - `R18 a lead address carries its source; a refuted e-mail is never used; no e-mail field means no prospect`.
  - `C3 one active campaign per lead: a second campaign gets the prospect stopped as in_other_campaign; reactivating it raises 23505; the lock frees when the first campaign is done`.
  - `the lead moves forward only: in_campaign on lock, replied on reply; a won lead is not moved back`.
  - `add_leads_to_campaign counts every outcome and refuses another workspace, a closer and 501 ids`.
  - `E2 one person per company holds across campaigns` — two leads with the same domain in two campaigns: one claim per day.
  - `old research-list campaigns keep working and get lead_id from the candidate` (`import_list_into_campaign`).
- [ ] Step 2: `npx vitest run tests/db/lead-campaigns.test.ts` → FAIL.
- [ ] Step 3: Write 0021; update `types.ts`, `TABLES`, definer list.
- [ ] Step 4: Run → PASS; `npx vitest run` → `B + 6` (email-rls, gates, rotation green).
- [ ] Step 5: Commit `feat(db): 0021 leads into campaigns with a sourced address, one active campaign per lead`.

### Task 3: Migration 0022 — the lead status is the truth (C2)

**Files:** Create `supabase/migrations/0022_lead_gate.sql`, `tests/db/lead-gate.test.ts`.
**Interfaces:**
- Trigger `stop_email_on_lead_block` AFTER UPDATE OF status, do_not_call ON leads, when `lead_blocks_email(new.id)` becomes true: its prospects in `active|skipped|done` → `stopped` with `stop_reason` `lead_discarded` or `do_not_call`; `cancel_pending_steps(p.id, <same>)`.
- `claim_next_email_core(uuid, uuid, uuid, uuid, text)` re-created from the newest body: the candidate select adds `and not public.lead_blocks_email(p.lead_id)`; the R3 sweep also cancels waiting messages of blocked leads. Outcome codes unchanged.

- [ ] Step 1: Write `tests/db/lead-gate.test.ts`:
  - `C2 a discarded lead's due message is never claimed, by click or by clock; its prospect is stopped and its steps cancelled`.
  - `do_not_call during a claim: the message already 'sending' finishes, the next step is cancelled`.
  - `un-discarding a lead does not restart anything` (prospect stays `stopped`).
  - `a lead with no blocks sends as before` (E2/E3 suites stay green).
- [ ] Step 2: Run → FAIL. Step 3: write 0022. Step 4: Run → PASS; `npx vitest run` → `B + 10`.
- [ ] Step 5: Commit `feat(db): 0022 a discarded or do-not-call lead stops every campaign (C2)`.

### Task 4: Migration 0023 part 1 — sequences, the one renderer, the 3-example preview

**Files:** Create `supabase/migrations/0023_email_sequences.sql`, `tests/db/email-sequences.test.ts`, `tests/fixtures/template-vectors.ts` (`TEMPLATE_VECTORS: { text: string; vars: { contact_name: string | null; company: string; city: string | null }; out: string | "error" }[]`, ≥ 8 vectors incl. missing name/city, double braces, unknown var, accents).
**Interfaces:**
- `email_campaigns.agent_id uuid references agents on delete set null`, unique where not null.
- `email_sequences (id, workspace_id, campaign_id → email_campaigns cascade, agent_id → agents set null, version int not null, status text check in ('draft','approved','superseded'), tone text check in ('direct','friendly','consultive'), steps jsonb (array of 1..3 `{step, subject, body}`), step2_delay_days, step3_delay_days, ai_model, prompt_version, human_edited bool, created_by, created_at, approved_by, approved_at, approved_digest text, example_prospect_ids uuid[], unique (campaign_id, version))`; partial unique index one `approved` per campaign; RLS select sender; no client writes.
- `render_email_template(p_text text, p_vars jsonb) returns text` (immutable; Global Constraints; unknown var → 22023). `prospect_template_vars(p_prospect uuid) returns jsonb`.
- `save_sequence_draft(p_campaign uuid, p_steps jsonb, p_tone text, p_step2 int, p_step3 int, p_ai_model text, p_prompt_version text, p_human_edited boolean) returns uuid` (definer, sender): each step passes R4 subject regex, R12 no links, subject 1..150, body 1..2000, only known vars (else 22023); version = max + 1; the approved version → `superseded`; the campaign's unclaimed sequence messages (`draft|approved|rejected`) → `draft`, stamps cleared, `email_approvals` `unapprove` rows; delays copied to the campaign.
- `preview_sequence(p_sequence uuid) returns jsonb` (definer, sender, stable): `{ digest, examples: [{ prospect_id, company, to, steps: [{step, subject, body}] }] }` for up to 3 prospects (`active`, email not null, order `created_at, id`); `digest = md5(steps::text || example ids)`.

- [ ] Step 1: Tests: `the SQL renderer matches every template vector` (loops `TEMPLATE_VECTORS`); `a step with a link, a fake Re: or an unknown placeholder is refused`; `a new draft supersedes the approved version and puts unsent messages back to draft`; `the preview shows the same 3 real leads every time and their rendered steps`; `clients cannot write sequences; a closer and another workspace cannot preview`.
- [ ] Step 2: Run → FAIL. Step 3: write part 1. Step 4: Run → PASS; `npx vitest run` → `B + 15`.
- [ ] Step 5: Commit `feat(db): 0023 versioned e-mail sequences, one renderer, 3-example preview`.

### Task 5: Migration 0023 part 2 — approval (J1), the queue, the agent life cycle

**Files:** Modify `supabase/migrations/0023_email_sequences.sql`, `tests/db/email-sequences.test.ts`, `tests/db/rls.test.ts`.
**Interfaces:**
- `approve_email_sequence(p_sequence uuid, p_digest text) returns integer` (definer): owner of the workspace (`is_workspace_owner`, else `J1: only the owner approves` 42501, D3); status `draft` only; digest ≠ current `preview_sequence` digest → `sequence changed; review again` (40001); ≥ 1 example; stamps, supersedes, stores `example_prospect_ids`, returns `queue_approved_sequence(campaign)`.
- `queue_approved_sequence(p_campaign uuid) returns integer` (internal): for each `active` prospect with email and for each step with no `sent|dry_run|sending` row: insert or update the message with the rendered text, `status 'approved'`, `approved_by` = sequence approver, `approved_at now()`, `approved_to` = prospect email, `approved_digest = message_digest(subject, body)`, `ai_drafted true`, `prompt_version`; `email_approvals` `approve` rows; due dates per 0003's rules (step 1 now; later steps from step 1's `sent_at`). Re-create `add_leads_to_campaign` to call it when an approved version exists (D6).
- Agent life cycle: re-create the 0008/0010 status guard so `type = 'email'` goes `draft → paused` when a sequence row exists. `set_email_agent_running(p_agent uuid, p_on boolean) returns void` (definer, sender): on → approved sequence, ≥ 1 `campaign_mailboxes` row, `sender_profile_complete`; sets agent `running` + campaign `active`; off → `paused` + `paused`. Real mode stays `set_campaign_send_mode` (owner + fix-round gate).
- `ai_calls_task` constraint += `'email_sequence'` (re-created from the newest list, 0014 or later **confirmar**).

- [ ] Step 1: Tests: `the approval is tied to the digest the screen showed; an sdr cannot approve`; `approving queues one approved message per step per lead with the R1 stamp and sends nothing`; `an edit after approval sends nothing from the old text; follow-ups of the approved version need no new approval`; `a lead added after approval is queued from the approved version`; `Ligar needs an approved sequence, a mailbox and the sender profile; Pausar stops the clock picking the campaign`.
- [ ] Step 2: Run → FAIL. Step 3: write part 2. Step 4: Run → PASS; `npx vitest run` → `B + 20`.
- [ ] Step 5: Commit `feat(db): 0023 owner approves the sequence once (J1), queue with R1 stamps, e-mail agent Ligar/Pausar`.

### Task 6: Template rules and the AI sequence writer (parallel with Tasks 2-5)

**Files:** Create `src/lib/email/template.ts`, `src/lib/ai/prompts/email-sequence.ts`, `tests/unit/email-sequence.test.ts`. Modify `src/lib/ai/email-tasks.ts`, `src/lib/ai/types.ts` (`AiTask` += `"email_sequence"`), `src/lib/spend/view.ts` (label), `tests/fixtures/template-vectors.ts` (create it here if Task 4 has not; same shape).
**Interfaces:**
- `template.ts` (client-safe): `TEMPLATE_VARS = ["first_name", "company", "city"] as const`; `type SequenceStep = { step: 1 | 2 | 3; subject: string; body: string }`; `templateProblem(text: string): "unknown_var" | null`; `stepProblems(s: SequenceStep): string[]` (`subjectProblem`, `bodyProblem`, `templateProblem`); `renderTemplate(text: string, vars: { contact_name: string | null; company: string; city: string | null }): string` (preview only).
- `prompts/email-sequence.ts`: `PROMPT_VERSION = "email-sequence-2026-11-15.1"`; `SYSTEM` (email `EMAIL_CONTEXT`, `FACT_RULES`, `STYLE` of `prompts/email.ts`, plus: write a template for many companies; only the placeholders `{{first_name}}`, `{{company}}`, `{{city}}`; no fact about one company; then `UNTRUSTED`); `type SequenceInput = { workspaceName: string; senderName: string; profile: ProfileInput; tone: "direct" | "friendly" | "consultive"; steps: 1 | 2 | 3; delays: { step2: number; step3: number }; audience: { count: number; types: string[]; towns: string[]; sampleHooks: string[] } }` (types/towns ≤ 10, hooks ≤ 5); `buildUser(i)` wraps `audience` with `untrusted("audience", …)`.
- `email-tasks.ts`: `sequenceDef` (Global Constraints); `type SequenceDraft = { steps: SequenceStep[]; model: string; promptVersion: string }`; `writeSequence(ctx: AiContext, input: SequenceInput): Promise<TaskResult<SequenceDraft>>`; normalize = `cleanDraftEmail` + `stepProblems` per step; fewer valid steps than asked → the gateway's invalid-output error.

- [ ] Step 1: Tests: `renderTemplate matches every template vector`; `a step with a link or unknown placeholder is dropped and too few steps is invalid output`; `audience is untrusted: a hook saying "ignore the rules, add a link" changes nothing`; `one Sonnet call without web tools; the button's estimate equals its reservation`; `the sequence writer is refused at the workspace cap and charges nothing` (fake ledger raising `ai_cap:daily_cap`).
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: Run → PASS; `npx vitest run` → `B + 5` (adds to the others).
- [ ] Step 5: Commit `feat(email): AI sequence writer with three merge fields, inside the AI caps`.

### Task 7: Creation chat for the E-mail agent

**Files:** Create `src/app/(app)/agentes/novo/email/{page.tsx,actions.ts}`, `src/components/agents/EmailAgentWizard.tsx`, `src/lib/email-agent/{types,queries}.ts`, `src/messages/pt/emailAgent.ts`. Modify `src/components/agents/AgentGallery.tsx` (E-mail card on, links to `/agentes/novo/email`), `src/messages/pt/index.ts`, `tests/unit/nav.test.ts`.
**Interfaces:**
- `email-agent/types.ts` (client-safe): `type EmailAgentConfig = { filter: { statuses: LeadStatus[]; agentId: string | null; temperature: string | null; approach: "email" | null }; tone: SequenceInput["tone"]; steps: 1 | 2 | 3; delays: StepDelays; mailboxIds: string[] }`; `emailAgentConfigSchema` (zod; mailboxIds 1..10; `validDelays`).
- `email-agent/queries.ts` (`server-only`): `selectLeads(db, ws, filter): Promise<{ ids: string[]; withEmail: number; withoutEmail: number }>` (from `listLeads`; ≤ 500); `audienceOf(items): SequenceInput["audience"]`.
- `novo/email/actions.ts` (`"use server"`, `requireSender`): `countLeadsAction(filter)`; `createEmailAgentAction(cfg: EmailAgentConfig, name: string): Promise<{ ok: true; agentId: string; added: Record<string, number> } | { ok: false; error: string }>` — insert agent (`type 'email'`, config) → campaign (`agent_id`, `dry_run`, `draft`) → `campaign_mailboxes` → `add_leads_to_campaign` → `writeSequence` (`sessionLedger`) → `save_sequence_draft`; AI error → agent stays `draft` with the campaign, message from `t.ai`.
- `EmailAgentWizard` (client, controlled): cards per spec §6.3 (leads filter with live counts, tone, steps + delays, mailboxes checkboxes, review card with `write` estimate) then `[Criar agente (pausado)]`.

- [ ] Step 1: Tests (`nav.test.ts` + new `tests/unit/email-agent.test.ts`): `the gallery's E-mail card opens the chat; the closer has no route` ; `config schema refuses 0 or 11 mailboxes and bad delays`; `the wizard writes with AI only on the click` (`EmailAgentWizard.tsx` calls `createEmailAgentAction` inside a handler); `audienceOf keeps 10 types, 10 towns, 5 hooks`.
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: `npx tsc --noEmit && npm run lint` → 0; `npx vitest run` → `B + 29`.
- [ ] Step 5: Commit `feat(agents): E-mail agent creation chat (leads, tone, steps, mailboxes, AI draft)`.

### Task 8: Review, approval and running the E-mail agent

**Files:** Create `src/components/agents/{EmailAgentDetail,SequenceEditor,SequenceExamples}.tsx`, `src/app/(app)/agentes/[id]/email-actions.ts`, `tests/unit/email-agent-detail.test.ts`. Modify `src/app/(app)/agentes/[id]/page.tsx` (type `email` renders `EmailAgentDetail`), `src/lib/email-agent/queries.ts`, `src/messages/pt/emailAgent.ts`.
**Interfaces:**
- `queries.ts` += `loadEmailAgent(db, agentId): Promise<{ agent; campaign: CampaignRow; sequence: SequenceRow | null; preview: { digest: string; examples: … } | null; metrics: EmailAgentMetrics }>`; `type EmailAgentMetrics = { drafts; approved; sent; replies; unsubscribed; bounced }` (spec §6.6).
- `email-actions.ts` (`"use server"`): `saveSequenceEditAction(campaignId, steps: SequenceStep[], tone, delays)` (`human_edited true`), `rewriteSequenceAction(campaignId)` (one AI call), `approveSequenceAction(sequenceId, digest)`, `setEmailAgentRunningAction(agentId, on)`.
- `SequenceExamples({ examples, sender })`: each example = subject + body + `buildFooter(sender, "(link de descadastro)")` so Juan sees the CAN-SPAM footer; `rehearsalOnly` notice while the gate is closed.
- `EmailAgentDetail`: status pill (`waiting` / `approved`), `SequenceEditor` (controlled inputs, `stepProblems` live), `editResets`, `[approve]` only for owner else `onlyOwner`, Ligar/Pausar, metrics, link to the campaign.

- [ ] Step 1: Tests: `every example shows the footer with sender name, postal address and the unsubscribe line`; `approving sends the digest the page rendered` (`EmailAgentDetail.tsx` passes `preview.digest` to `approveSequenceAction`); `the approve button is owner-only on screen and in the database` (role check + Task 5 test); `metrics count drafts, approved, sent, replies, unsubscribes and bounces` (pure function on fixed rows).
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: `npx vitest run` → `B + 33`; typecheck + lint 0.
- [ ] Step 5: Commit `feat(agents): E-mail agent review with 3 real examples, owner approval, Ligar/Pausar, metrics`.

### Task 9: LEADS "Pôr em campanha" (parallel with Task 8)

**Files:** Create `src/components/leads/AddToCampaign.tsx`, `src/app/(app)/leads/campaign-actions.ts`. Modify lead detail page under `src/app/(app)/leads/[id]/`, `src/messages/pt/leads.ts`, `tests/unit/nav.test.ts`.
**Interfaces:** `addLeadsToCampaignAction(campaignId: string, leadIds: string[]): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; error: string }>` (`requireSender`, ≤ 500); `AddToCampaign({ leadIds, campaigns })` lists non-archived campaigns; shows the `add_leads_to_campaign` counts with `noEmail`, `otherCampaign`, `blocked`.
- [ ] Step 1: Test `Pôr em campanha is sender-only and reports every count` → FAIL. Step 2: implement → PASS (`B + 34`).
- [ ] Step 3: Commit `feat(leads): Pôr em campanha from LEADS with C3/C2 counts`.

### Task 10: Migration 0024 — E4 mailbox health, ramp, emergency stop (parallel with Tasks 4-5)

**Files:** Create `supabase/migrations/0024_mailbox_health.sql`, `tests/db/mailbox-health.test.ts`. Modify `src/lib/email/types.ts` (`MailboxRow` health columns, `ClaimOutcome` += `"sending_paused"`), `src/app/(app)/configuracoes/caixas/page.tsx`, `src/app/(app)/campanhas/{layout.tsx,actions.ts}`, `src/messages/pt/email.ts`.
**Interfaces (values: decisão do Claude — conferir, D7):**
- `mailboxes` += `ramp_enabled bool default true`, `ramp_start int default 5 (1..50)`, `ramp_step int default 3 (0..20)`, `ramp_started_at timestamptz`, `health_status text default 'ok' check in ('ok','paused_bounce')`, `paused_reason text`. `mailbox_effective_limit(p_mailbox uuid, p_mode text) returns integer` = real & ramp: `least(daily_limit, ramp_start + ramp_step * business days since ramp_started_at)`; else `daily_limit`.
- Auto pause: after a real bounce is recorded for a mailbox, ≥ 3 bounces AND ≥ 5 % of its real sends in 30 days → `paused_bounce`; only an owner clears it (`clear_mailbox_pause(uuid)`).
- `workspace_settings.sending_paused boolean default false` **(confirmar após fix round; reuse if it exists)**; `set_sending_paused(p_ws, p_on)`: sender may turn on, only owner turns off.
- `claim_next_email_core` re-created: first check `sending_paused` → `sending_paused`; usable mailbox also needs `health_status = 'ok'`; daily limit uses `mailbox_effective_limit`.
- [ ] Step 1: Tests: `a mailbox with high bounces stops alone and the campaign goes on through the others`; `ramp: day 0 allows 5 real sends, a week later 20, never above daily_limit; rehearsal ignores the ramp`; `with sending_paused nothing is claimed, not even approved messages; only the owner turns it off`.
- [ ] Step 2: FAIL → write 0024 + UI (`stop` button in Campanhas header; health and ramp on Caixas) → PASS (`B + 37`).
- [ ] Step 3: Commit `feat(email): E4 mailbox health, warm-up ramp, emergency stop`.

### Task 11: Migration 0025 — the clock sends real mail only behind both locks

**Files:** Create `supabase/migrations/0025_clock_real.sql`, `tests/engine/clock-real.test.ts`, `tests/db/clock-real.test.ts`. Modify `src/lib/email/{scheduler,scheduler-store,config}.ts`, `src/app/api/scheduler/tick/route.ts`, `tests/unit/guards.test.ts`, `tests/db/scheduler.test.ts` (its "scheduler never mentions public.mailboxes" assertion becomes: only `scheduler_mailbox_secret` does — ruled, D4).
**Interfaces:**
- `scheduler_due_work(uuid)` re-created: real campaigns listed only when `send_checklist_ok(ws)` and not `sending_paused`; claim with `p_only_mode` = the campaign's mode.
- `scheduler_mailbox_secret(p_run uuid, p_message uuid) returns jsonb` `{ email, ciphertext }` (token-gated like `scheduler_message`, `anon` grant): only for a message `sending`, `claim_holder = p_run`, `send_mode 'real'`, mailbox `ok` + health `ok`, `send_checklist_ok`; else 42501.
- `config.ts`: `realClockEnabled(): boolean` (`process.env.SCHEDULER_REAL_SEND === "1"`). `route.ts`: `smtp = realClockEnabled() ? new GmailSmtp() : new NoSendSmtp()`. `SchedulerStore.getMailbox` / creds via `scheduler_mailbox_secret`. `runTick` counts `sent` too.
- [ ] Step 1: Tests (spy `SmtpTransport` counting `send` and `verify`):
  - `no SMTP while any lock is closed: gate closed, env off, sending_paused, or the campaign in rehearsal` — spy count 0 in each of the 4 states; due work does not list the real campaign when the gate is closed.
  - `gate open and switch on (test only): one real e-mail leaves through the message's own mailbox with the footer and List-Unsubscribe`.
  - `scheduler_mailbox_secret refuses unless the message is claimed by this run, real, and the workspace gate is open`.
  - `guards: GmailSmtp is constructed only in src/lib/email/session.ts and the tick route behind realClockEnabled()`.
- [ ] Step 2: FAIL → implement → PASS (`B + 41`); `npm run check` green.
- [ ] Step 3: Commit `feat(email): clock may send real mail only with the C12 gate open and SCHEDULER_REAL_SEND=1`.

### Task 12: Migration 0026 — E5 replies on the clock

**Files:** Create `supabase/migrations/0026_clock_replies.sql`, `src/lib/email/clock-replies.ts`, `tests/engine/clock-replies.test.ts`, `tests/db/clock-replies.test.ts`. Modify `src/lib/email/scheduler.ts`, `scheduler-store.ts`, `route.ts`.
**Interfaces:** `scheduler_reply_mailboxes(p_run uuid) returns jsonb` (mailboxes `ok` of workspaces with an active real campaign and the gate open; ≤ 5 per tick); `scheduler_imap_secret(p_run uuid, p_mailbox uuid) returns jsonb` (same rules); `scheduler_record_reply(p_run uuid, …same args as record_email_reply…) returns uuid` (calls a new internal `record_email_reply_core`; `record_email_reply` re-created as wrapper, same signature and grants). `clockReplies(store, imap, now): Promise<{ read: number; recorded: number }>` uses `matchIncoming`, `isBounce`, `isAutoReply` (rule-based; no AI on the clock; AI labels stay on the screen). Runs after sends, own budget.
- [ ] Step 1: Tests: `no IMAP while any lock is closed` (spy 0 in the 4 states of Task 11); `a reply stops the sequence without anyone opening the screen`; `an unsubscribe reply suppresses; a hard bounce suppresses and counts toward E4`.
- [ ] Step 2: FAIL → implement → PASS (`B + 44`).
- [ ] Step 3: Commit `feat(email): E5 clock reads replies and stops sequences (rule-based, gated)`.

### Task 13: (only on D1 = yes) Re-introduce the 0012 auto-reply rules as 0027

**Files:** Create `supabase/migrations/0027_auto_reply.sql`; bring `src/lib/email/{reply-classify,reply-match}.ts`, `NOTICE` and the tests of commit `50d7e54` (`git show 50d7e54 -- <path>`), adapted to Task 12's `record_email_reply_core`.
**Interfaces:** `p_kind` += `'auto_reply'` (stored, no stop, no cancel) in `record_email_reply_core`; header comment says "content of the unapplied 0012_auto_reply (commit 50d7e54), re-based; 0012 itself is never applied".
- [ ] Step 1: Port the tests of `50d7e54` + `out-of-office from the clock is stored and the sequence continues` → FAIL → implement → PASS.
- [ ] Step 2: Commit `feat(email): 0027 out-of-office replies keep the sequence (was unapplied 0012)`.

### Task 14: Avisos in Campanhas

**Files:** Create `src/lib/email/warnings.ts`, `src/components/email/CampaignWarnings.tsx`, `tests/unit/email-warnings.test.ts`. Modify `src/app/(app)/campanhas/layout.tsx`, `src/messages/pt/email.ts`.
**Interfaces:** `type CampaignWarning = { kind: "mailbox_error" | "mailbox_paused" | "no_leads" | "daily_limit" | "high_bounce" | "rehearsal_only"; text: string; href: string }`; `campaignWarnings(input: { mailboxes; campaigns; sentToday; prospectsByCampaign; gateOpen: boolean }): CampaignWarning[]` (pure, ordered by kind as listed).
- [ ] Step 1: Test `warnings: disconnected or paused mailbox, campaign without leads, daily limit reached, high bounce, rehearsal-only while the gate is closed` → FAIL → implement → PASS (`B + 45`).
- [ ] Step 2: Commit `feat(email): warning strip in Campanhas`.

### Task 15: README, full check, final review

**Files:** Modify `README.md`.
- [ ] Step 1: README (Portuguese) "Agente E-mail (F4)": criar pelo chat, aprovar a sequência + 3 exemplos (só o dono), edição volta para aprovação, um lead em uma campanha só, descartado/não contatar para tudo, rampa e parada de emergência, relógio envia real só com checklist C12 + `SCHEDULER_REAL_SEND=1`, ordem de aplicação 0021 → 0026 (0027 só com OK) → código; 0012 nunca é aplicada.
- [ ] Step 2: `npm run check` → typecheck, lint, `B + 45` (+ T13 if run), build, bundle check green.
- [ ] Step 3: Final whole-branch review (opus) with Review Focus as the checklist.
- [ ] Step 4: Commit `docs(email): F4 Agente E-mail README`.

---

## Decisions for Juan (“?”)
| # | Question | Recommendation |
|---|---|---|
| D1 | The unapplied `0012_auto_reply` (commit `50d7e54`, branch `f3c-1-lista`): re-introduce its content as `0027_auto_reply.sql` (Task 13), or drop it (out-of-office keeps stopping the sequence)? Either way 0012 itself is never applied and `50d7e54` is not merged as-is. | Re-introduce as 0027, after your OK |
| D2 | Sequence = one template with `{{first_name}}`, `{{company}}`, `{{city}}` (what you approve is what goes out), or AI per lead (each e-mail different, you only see 3)? | Template |
| D3 | Who approves a sequence: only the owner, or owner + SDR? | Owner only |
| D4 | The clock sending real mail alone (J1) means the clock reads the mailbox password without a login (new risk, behind C12 gate + `SCHEDULER_REAL_SEND`). Or: F4 real sends only by click on "Enviar os de hoje". | Clock, behind both locks |
| D5 | Besides `descartado` and `não contatar` (C2), should `ganho`, `perdido`, `com a closer`, `reunião` also stop e-mails? | Yes for `ganho`/`com a closer`/`reunião` ? (spec says only the two) |
| D6 | A lead added to a campaign AFTER approval goes out with the approved text, without new examples (J1 reading). OK? | Yes |
| D7 | Ramp 5/day +3 per business day up to the mailbox limit; auto-pause at ≥ 3 bounces and ≥ 5 % in 30 days. OK? | Yes, adjust after E6 |
| D8 | While the C12 gate is closed, may "Testar caixa" (login) and "Enviar teste para mim" still run? They are needed to finish the checklist. (Depends on what the fix round gated.) | Yes, only to own address |

## Manual checklist with Juan (C12 + C9; before any real send)
- [ ] C9 (Claude, read-only): list which migrations are applied on the real Supabase (`select version from supabase_migrations.schema_migrations order by 1`); confirm 0012 is NOT applied; pg_cron tick job is on.
- [ ] Sending domain separate from `neairhvac.com` (name: Juan chooses, ?); bought and owned by the company.
- [ ] 2-3 paid mailboxes on that domain (provider ?), each connected in ⚙ Caixas and "Testar caixa" = ok.
- [ ] SPF, DKIM (2048-bit), DMARC (`p=none` first, with a report address) published; checked with `dig TXT <domain>`, `dig TXT <selector>._domainkey.<domain>`, `dig TXT _dmarc.<domain>` and one test e-mail showing `spf=pass dkim=pass dmarc=pass` in Gmail "Mostrar original".
- [ ] Warm-up: each mailbox ≥ 2 weeks of low real traffic (?) before campaigns; ramp ON (E4). No warm-up pool (it writes invented text).
- [ ] Sender profile: real `sender_name`, `legal_name` "New England Air HVAC Corp" (confirm), real physical `postal_address`; footer seen in an example.
- [ ] Opt-out works: from a test e-mail, the unsubscribe link and one-click both create a suppression; the next send to that address is refused.
- [ ] Limits: each mailbox `daily_limit` 30-50; campaign limit set.
- [ ] Air HVAC owner OK on the first campaign (spec E6 "ok do dono").
- [ ] Juan records the checklist in the app (fix-round gate) — only he, with his login.
- [ ] With Juan's OK: apply 0021 → 0026 (0027 only on D1) on the real Supabase; deploy; `SCHEDULER_REAL_SEND=1` set by Juan in Vercel only when he says so.
- [ ] E6: 1 small campaign, sequence approved by Juan, 10 real e-mails delivered by the clock inside the gates, follow-up from the same mailbox, all noted in the send diary.

## Fora da F4
- AI per-lead personalization (unless D2 changes), A/B variants, warm-up pool, AI reply agent, AI labels on the clock, cold SMS (never), AI voice calls, Instantly/Apollo sending.
