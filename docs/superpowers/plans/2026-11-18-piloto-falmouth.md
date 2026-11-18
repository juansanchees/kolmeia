# Piloto Falmouth (HVAC em obra nova) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A local, reproducible pilot of the Caçador for the offer "HVAC installation for new construction" in Falmouth, MA. Our own collected data (Maps robot, permits, projects, company sites) goes into the shared base `kb_*`. Permits are crossed with companies. An offer rule judges each opportunity. Gaps are resolved automatically. Each opportunity is delivered into the Air HVAC call queue with why-call, who-to-call and an English hook backed by evidence. The pilot is scored against the Falmouth gold list.

**Architecture:** This plan is Plan A (`2026-11-17-fase1-base-construcao-ma.md`) Tasks 2–5, with pilot deltas, plus four pilot pieces:
1. A reusable offer-rule module (`src/lib/offers/`).
2. A gap resolver with per-town, per-source coverage records.
3. Workspace-scoped opportunities that are shown on the call screen.
4. An operator pilot script and an evaluation script.

Both scripts read private data from outside the repo.

**Spec:** `docs/superpowers/specs/2026-11-17-motor-de-dados-design.md`. Request: `/Users/juansanchees/Documents/Hvac - Project/docs/voz/prompt-claude-piloto-falmouth.md` (Juan, 18/11/2026). Gold method: `/Users/juansanchees/Documents/Hvac - Project/docs/pesquisa-padrao-ouro.md`.

## Global Constraints
- Plan A's Global Constraints apply in full, with these changes:
  - Branch `piloto-falmouth`, cut from `leads-redesign`.
  - Migrations `0040_kb_base.sql` and `0041_kb_delivery.sql`.
  - The scripts are named `pilot-*`, not `kb-*`.
- The REPO IS PUBLIC. No real company, person, phone, address, permit number, gold label or key goes in code, fixtures, tests, commit messages or reports inside the repo. Tests use invented data (`Acme Builders LLC`, `555-01xx`, `example.com`, `12 Example Rd`).
- Private inputs are read from `PILOT_DATA_DIR`, which must be outside the repo (the script refuses a path inside it). The default is `/Users/juansanchees/Documents/Hvac - Project/data`. The report is written to `PILOT_OUT_DIR`, also outside the repo.
- Gold labels never reach the pilot's input:
  - The pilot script does not read `data/gold/` at all.
  - Only the eval script reads gold.
- Database target: the pilot and eval scripts refuse any Supabase URL containing the prod ref `qkrlfmtmvllugkgvafxt`. Allowed: `localhost`/`127.0.0.1`, or the dev ref `drkonindwshyyaemkcod` with `PILOT_ALLOW_DEV=1`.
- No paid AI in the pilot path:
  - The offer rule, matching and hook are deterministic code.
  - Any AI comparison run is an ORCHESTRATOR step that needs Juan's ok.
- Live network (site reads, permit portal) only when `PILOT_LIVE=1`.
  - It goes through `readSite` (robots.txt, ≤1 req/s per host, honest UA).
  - Without the flag, only archived files are used, and each skipped live step is recorded as coverage outcome `skipped` with reason `live off`.
- D13: a person's phone/e-mail/address is never stored. An applicant phone may be used in memory to match a company phone. It is never written.
- Offer IDs are stable strings. This pilot ships `hvac_new_construction`. The registry must take `building_maintenance` later without changing callers.
- Copy: pt and en messages in parity. Never the word "LinkedIn". Hooks are English. Reasons and questions shown to the SDR are Portuguese (pt) and English (en) through messages, and are built from structured codes, not free AI text.

## Review Focus
1. **Same data imported twice** → no duplicate company, signal, opportunity, lead, link or call-list item (tests in P1, P2, P5).
2. **Permit with no identifiable company** → kept as an opportunity with `responsible_party = missing` and the call question "who is the GC?". Never attached to a guessed company (P1, P3).
3. **Two similar company names and no proof** → link stays `pending` with both candidates. Neither is delivered as confirmed (P1).
4. **A source down or blocked** (HTTP 403, timeout, robots) → the next source is tried, a coverage row records town, source, date, outcome and reason, and the run finishes (P3, P5).
5. **Client isolation** → a user of another workspace cannot read opportunities or coverage of the Air HVAC workspace (P2, P4).

---

### Task P1: Base tables and `kb_ingest` (Plan A Tasks 2 + 3, with pilot deltas)
Para o Juan: crio as gavetas da base e a função que junta a mesma empresa vinda de fontes diferentes, guardando também alvarás sem empresa conhecida.

Do Plan A Task 2 and Task 3 exactly (read them in `docs/superpowers/plans/2026-11-17-fase1-base-construcao-ma.md`), with these deltas in `0040_kb_base.sql`:
- `kb_signals`:
  - `company_id` nullable.
  - New columns: `applicant_name text ≤200`, `permit_no text ≤60`, `link_status text not null default 'none' check in ('confirmed','pending','none')`, `link_note text ≤300`.
  - New table `kb_signal_candidates(signal_id uuid → kb_signals on delete cascade, company_id uuid → kb_companies on delete cascade, reason text ≤120, primary key (signal_id, company_id))`.
- `kb_ingest`, `match_only` signals:
  - Unique match → `company_id` set, `link_status 'confirmed'`.
  - Two or more candidates → `company_id` null, `link_status 'pending'`, candidates written.
  - No candidate → `company_id` null, `link_status 'none'`.
  - The signal is ALWAYS written; Plan A's "skip" is replaced.
  - A later ingest with a unique match upgrades `pending`/`none` to `confirmed` and clears the candidates.
  - It never downgrades `confirmed`.
  - Result counters: add `signals_unlinked` and `signals_pending`; `skipped_unmatched` is dropped.
- `kb_jobs` (coverage):
  - Kind adds `'pilot'`.
  - New columns: `outcome text check in ('ok','partial','blocked','robots','down','login','empty','skipped')`, `queried int default 0`, `rows_in int default 0`, `reason text ≤300`.
- New `kb_source_meta(source text pk check in KB_SOURCES, label text, terms_url text, allowed_uses text ≤300, restrictions text ≤300)`, seeded with one row per KB source. Use plain, honest text, e.g. `maps_robot`: "internal use, modest volume, no resale"; `permit`: "public record"; `site_robot`: "public company pages, robots.txt honoured".
- RLS stays closed on all `kb_*` tables.

Tests: every Plan A Task 2 + 3 test, adapted where the deltas change them (`ambiguous name not attached` now expects `link_status = 'pending'` with 2 candidates and the signal stored), plus:
- `permit without company kept`
- `pending upgraded by later unique match`
- `confirmed never downgraded`
- `second ingest of same permits and maps rows changes no counts`

Commit: `feat(kb): shared base, kb_ingest with pending links (0040)`.

### Task P2: Delivery and workspace opportunities (Plan A Task 4, with pilot deltas)
Para o Juan: copio as empresas e as oportunidades da base para os leads da Air HVAC e coloco na fila de ligações, sem duplicar.

Do Plan A Task 4 exactly, plus in `0041_kb_delivery.sql`:
- Table `lead_opportunities`:
  - Columns: `id, workspace_id → workspaces cascade, lead_id → leads cascade, kb_signal_id uuid → kb_signals on delete set null, offer text 1..60, title text ≤200, signal_date date, source text, source_url text, priority int 0..100, priority_codes text[]` (structured reason codes from P3), `hook_en text ≤300, checks jsonb` (the P3 verdict checks), `open_questions text[]` (codes), `contact_path text check in ('phone','bids','vendor_portal','none'), contact_value text ≤300, status text default 'open' check in ('open','done'), updated_at`.
  - Unique `(workspace_id, lead_id, offer, kb_signal_id)`.
  - Select policy for workspace members, mirroring the leads policies. No direct insert/update for `authenticated`.
- `kb_deliver` rows accept an optional `opportunities` array, upserted on the unique key. A re-delivery updates the fields and creates no new row. Rows already linked (`skipped_linked`) still upsert their opportunities onto the linked lead.
- Call queue: delivered leads with an open opportunity must appear in the workspace's call flow (`/leads/ligar`, built by `build_call_list` from 0020), ahead of leads without one, ordered by `lead_opportunities.priority desc`. Read `build_call_list`/`lead_callable` in 0020 (and later migrations that replace them) and change the ordering with the smallest diff. Re-running delivery or rebuilding the list creates no duplicate `call_list_items` (the existing unique `(agent_id, lead_id, list_date)` must hold).

Tests (PGlite):
- first delivery with 2 opportunities
- retry idempotent (opportunity count unchanged, fields updated)
- second delivery on linked lead upserts opportunity only
- `member of other workspace cannot read opportunities`
- `authenticated cannot write opportunities`
- `call list puts opportunity leads first by priority`
- `rebuild call list no duplicate items`

Commit: `feat(kb): deliver companies with opportunities into the call queue (0041)`.

### Task P3: Offer rule, mappers, gap resolver (pure TypeScript)
Para o Juan: a regra que decide se uma obra serve para "HVAC em obra nova", separa o que está confirmado do que falta perguntar, escreve o gancho em inglês e tenta preencher as lacunas sozinha.

Files: `src/lib/kb/{types,fresh,load}.ts` (Plan A Task 5, all of it), `src/lib/offers/{types,index,hvac-new-construction}.ts`, `src/lib/kb/gaps.ts`, `src/lib/kb/coverage.ts`, tests under `tests/unit/`.

**Offer rule**
- `offers/types.ts`:
  - `type CheckState = 'confirmed' | 'missing' | 'no'`
  - `type OfferVerdict = { fit: 'yes' | 'maybe' | 'no'; checks: Record<'new_build'|'recent'|'hvac_fit'|'responsible_party'|'can_bid', { state: CheckState; evidence?: string; source_url?: string }>; openQuestions: string[] /* codes */; priority: number /* 0..100 */; priorityCodes: string[]; hookEn: string | null }`
  - `interface Offer { id: string; evaluate(input: OfferInput, now: Date): OfferVerdict }`
  - `OfferInput = { signal: KbSignal-like; company: { name, phone?, website? } | null; link_status; contacts: { phone?, bids_url?, vendor_portal_url?, source_url? } }`
- `offers/index.ts`: `OFFERS: Record<string, Offer>` and `getOffer(id)`, which throws on an unknown id.
- `hvac-new-construction.ts` (`id 'hvac_new_construction'`):
  - `new_build` is `confirmed` when the work class or description says new construction, new dwelling/house/building, ADU or new commercial building. It is `no` for repair/roof/solar/pool/fence/demolition-only/deck/siding/windows. Otherwise `missing`.
  - `recent`: issued ≤ 180 days → `confirmed`; ≤ 365 → `missing`; older or no date → `no`.
  - `hvac_fit`: a new building of any value, or value ≥ US$150,000 → `confirmed`; HVAC/mechanical explicitly by another trade already listed → `missing`; else `missing`.
  - `responsible_party`: link `confirmed` → `confirmed`, otherwise `missing`, with question code `ask_gc`.
  - `can_bid`: `confirmed` only with a `bids_url` or `vendor_portal_url` from a source. Otherwise `missing`, with question code `ask_taking_bids`.
  - `fit`: `no` if any of new_build/recent/hvac_fit is `no`; `yes` if new_build and recent are confirmed and a contact path exists; else `maybe`.
  - `priority`: points for recency, value, confirmed GC and contact path, documented in one table in the file.
  - `hookEn`, gold style, built only from evidence fields: `Saw the {Mon YYYY} permit for {short work} at {street} in Falmouth — who's handling the HVAC?`. It is `null` when there is no date or address.
  - Unit tests cover every branch, with invented data.

**Mappers**
- Plan A Task 5, plus:
  - `falmouthPermitItems(csv)` for the collector schema `source,permit_no,issued_on,address,town,work_class,use,value_usd,description,applicant_name,applicant_phone,contractor_name,source_url`. The applicant phone is used only for matching and is never put into values.
  - `massbuildsProjectItems(csv, town)` for `projects/projects_massbuilds.csv`.

**Gap resolver** (`gaps.ts`)
- `resolveGaps(opp, deps): Promise<{ contacts; link?; coverage: CoverageRow[] }>`.
- Ordered steps:
  1. Match by permit number.
  2. Match by applicant phone against company phones.
  3. Match by name_key + town.
  4. Read the company site for commercial phone, bids page and vendor-portal links.
- `deps` injects `readSite` and lookups.
- A thrown error, 403, robots or timeout → a coverage row with outcome and reason, then the next step.

**Coverage** (`coverage.ts`)
- `CoverageRow = { town, source, ran_at, outcome, queried, rows_in, reason? }` and a reducer to one row per (town, source).

**Tests**
- every check branch
- hook null without address
- registry unknown id throws
- `site 403 records blocked and continues`
- `robots disallow records robots`
- `permit without company asks for GC`
- `vendor portal link sets contact_path vendor_portal`

- Campaign params (from P4) shape the verdict without code changes per instruction: `evaluate(input, now, params?: CampaignParams)` with `CampaignParams = { preferKinds?: BuildingKind[]; deprioritizeKinds?: BuildingKind[]; minValueUsd?: number; wantBidPath?: boolean }` and `BuildingKind = 'single_family'|'adu'|'multifamily'|'commercial'|'other'`. The rule classifies `buildingKind` (multifamily = units ≥ 3, "multi-family", "apartments", "condo", "townhouses"; commercial = commercial/COMM use) and returns it in the verdict plus `facts` (the evaluation input snapshot, JSON) so the app can re-score later without the base. Demoted items get a priority code (e.g. `below_min_value`, `kind_deprioritized`); `wantBidPath` raises `can_bid` gaps to the top of open questions and of the gap resolver order.
- Offer metadata for proposals (used by P4): each `Offer` also exposes `meta = { audience: string /* code */, buyerCodes: string[], signalCodes: string[], sourceCodes: string[], profileFit(profile: CompanyProfileLike): { score: number; reasonCodes: string[]; assumptionCodes: string[]; missing?: string /* question code */ } }`. Ship `hvac_new_construction` fully and a `building_maintenance` stub whose `meta` is complete and whose `evaluate` returns `fit 'no'` with code `not_implemented` (proposal only; the Falmouth pilot does not run it).

Commit: `feat(offers): reusable offer rule (hvac_new_construction), gap resolver, coverage`.

### Task P4: Proposals, campaigns, rounds and preferences
Para o Juan: com só "quero mais clientes", o agente lê o perfil da empresa e propõe 2-3 buscas explicadas; a busca escolhida vira uma campanha com conversa salva, rodadas com motivo de parada e feedback que vale na hora; preferência permanente só depois da sua aprovação, com desfazer.

Files: `app/supabase/migrations/0042_hunt_campaigns.sql`, `src/lib/hunt/{proposals,interpret,rescore,rounds}.ts`, tests in `tests/db/` and `tests/unit/`.
- Tables (workspace-scoped, RLS for members like `leads`; writes only through `security definer` functions callable by `authenticated` members with role owner/sdr, after a membership check):
  - `hunt_campaigns(id, workspace_id, agent_id → agents on delete set null, offer text, region text, request text ≤1000, params jsonb default '{}', status text check in ('active','paused','done') default 'active', created_by, created_at, updated_at)`.
  - `hunt_rounds(id, campaign_id cascade, n int, started_at, ended_at, stop_reason text check in ('fulfilled','limit','exhausted','waiting'), request_snapshot text, params_snapshot jsonb, summary jsonb /* {new, updated, demoted, sources:[{source,town,outcome,reason}], blockers:[code], asks:[code]} */, unique (campaign_id, n))`.
  - `hunt_messages(id, campaign_id cascade, round_id → hunt_rounds set null, role text check in ('user','agent'), body text ≤4000, created_at)`. The conversation survives closing and reopening the app.
  - `lead_opportunities` gets `campaign_id uuid → hunt_campaigns on delete set null` and `facts jsonb` (from P3), plus `round_seen int`, `previous_priority int`.
  - `offer_preferences(id, workspace_id, offer text, rule jsonb /* CampaignParams subset */, status text check in ('proposed','approved','undone'), example_lead_ids uuid[], expected_effect jsonb /* {up:int, down:int} */, proposed_at, decided_by, decided_at)`. Scope = (workspace, offer). `undone` keeps the row (history).
- Functions: `hunt_campaign_create(p_ws, p_offer, p_region, p_request, p_params) → uuid`; `hunt_message_add(p_campaign, p_role, p_body, p_round)`; `hunt_campaign_apply(p_campaign, p_params, p_message)` (merges params, starts round n+1 with stop_reason null, re-scores this campaign's open opportunities with the new params via the stored `facts` — scoring itself is done in TS and written back through `hunt_round_finish(p_round, p_scores jsonb, p_summary jsonb, p_stop_reason)` so SQL stays dumb); `offer_preference_decide(p_pref, p_decision 'approved'|'undone')`.
- `proposals.ts`: `proposeSearches(profile, coverage, offers = OFFERS): Proposal[]` returns 2–3 items sorted by score, each `{ offer, titleCode, buyerCodes, whyFitCodes, signalCodes, sourceCodes, assumptionCodes, recommended: boolean, recommendReasonCodes }`, plus `question?: code` only when a missing profile fact would change the recommendation (e.g. no region). Deterministic, from the saved `company_profiles` row and site facts already stored; no AI. Test with an invented HVAC-installer profile: proposals include `hvac_new_construction` and `building_maintenance` with different audiences and sources; an invented bakery profile does not get either (examples are test criteria, not fixed answers).
- `interpret.ts`: `interpretInstruction(text: string, lang: 'pt'|'en'): { params: Partial<CampaignParams>; understoodCodes: string[]; unknown: string[] }`, a deterministic phrase map (pt + en) covering at least: small/large houses, multifamily/apartments/condos, commercial, minimum value, "how to submit a bid / por onde apresentar orçamento", only recent. Unknown text → returned in `unknown` and the agent replies asking a simple question. Behind an `Interpreter` interface so an AI interpreter can replace it later (not built now: paid AI needs Juan's ok).
  Acceptance test: `"essas casas são pequenas demais; nesta busca priorize multifamiliares e descubra por onde apresentar orçamento"` → `{ deprioritizeKinds:['single_family','adu'], preferKinds:['multifamily'], wantBidPath:true }`.
- `rescore.ts`: re-evaluates stored `facts` with params + approved preferences of the same (workspace, offer) and returns per-opportunity `{priority, codes, movedUp|movedDown|same}`.
- `rounds.ts`: `summarizeRound(before, after, coverage, blockers) → summary` and `stopReason({fulfilled, spentUsd, limitUsd, elapsedMs, limitMs, newEvidence}) → 'fulfilled'|'limit'|'exhausted'|'waiting'` ('waiting' = only steps that need the person or live access are left; the rest continues).
- Preference proposals: `proposePreference(outcomes)` — when ≥3 call outcomes or explicit feedback on one campaign point the same way (e.g. ≥3 `not_interested`/`discarded` on `single_family`), propose a rule with the example lead ids and the expected effect on the current queue; never auto-apply.
- Tests:
  - `instruction applies to this campaign immediately`
  - `other campaign params untouched`
  - `preference only after approval`
  - `undo restores previous priorities`
  - `reopen keeps messages and rounds`
  - `round 2 reuses round 1 opportunities (no new rows, priorities updated)`
  - `stop reason waiting when only live steps remain`
  - `non-member cannot read or write campaigns`
  - `closer role cannot apply instructions` (if roles allow; else document)

Commit: `feat(hunt): search proposals, campaigns with rounds, instructions and approved preferences (0042)`.

### Task P5: Screens — first access, campaign chat, call facts, coverage
Para o Juan: na tela do agente, "quero mais clientes" mostra as 2-3 sugestões explicadas e um botão para aceitar; a conversa da campanha mostra cada rodada (novas, atualizadas, perderam prioridade, fontes, o que falta e por que parou); a ficha de ligação mostra obra, data com link, motivo, contato, gancho e perguntas; a Cobertura mostra cada cidade e fonte com o motivo.

- Agent page: an entry box with "quero mais clientes" (pt) / "I want more customers" (en). On submit, show `proposeSearches` cards in business language (who buys, why it fits, which signal, where the agent looks, assumptions), the recommended one marked, a one-click "Começar por esta", a free-text "Ajustar" box (goes through `interpretInstruction`), and "Outra busca" for a specific request. Accepting creates a `hunt_campaigns` row (offer, region from profile or the answer to the question).
- Campaign view (`/agentes/[id]/campanhas/[campaignId]` or a section on the agent page — pick the smallest that fits the existing layout): message thread from `hunt_messages`, one card per round with `summary` (new / updated / demoted / sources consulted with outcome / blockers and asks / stop reason in plain words), the input box for the next instruction, and the pending preference card (rule, examples, expected effect, Aprovar / Agora não, and Desfazer for approved ones).
- `CallFacts.tsx` (and the lead modal facts if they share data) shows the top open opportunity: title, date + source link, priority reasons, contact path (phone / "Cadastro de fornecedor" link / bids page), `hookEn` (lang="en"), open questions.
- `/leads/cobertura`: section "Por fonte" with one row per (town, source): date, outcome, entered count, reason. Read through `kb_coverage(p_ws uuid)` (security definer in 0041 or 0042; membership check; operator rows + that workspace's rows).
- Agent setup: store `offer` and `campaign_id` in the agent config. The AI hunter run is unchanged.
- Plan A Task 10 `/bot` page as specified there.
- pt/en in parity, every code from P3/P4 has a message.
- Tests: component/source tests in the existing style, the parity test, and `kb_coverage` membership.

Commit: `feat(ui): first-access proposals, campaign rounds chat, opportunity call facts, coverage by source`.

### Task P6: Pilot runner and evaluation scripts
Para o Juan: um comando roda cada rodada do piloto de Falmouth com os dados que já temos e outro compara o resultado com a lista padrão-ouro, sem a lista padrão-ouro entrar no agente.

- `scripts/pilot-env.ts`:
  - Guards for `PILOT_DATA_DIR`/`PILOT_OUT_DIR` outside the repo and the DB URL rule.
  - Service key from env `PILOT_SERVICE_KEY` (local Supabase only) or Keychain service `kolmeia-pilot-local`, account `kolmeia-pilot`.
- `scripts/pilot-falmouth.smoke.ts`, skipped unless `PILOT_RUN=1`. Takes `PILOT_CAMPAIGN_ID` (round runner for that campaign) and `PILOT_WORKSPACE_ID`. Steps:
  1. Load Falmouth rows from `ma_sweep/maps/raw/falmouth.csv`, Falmouth rows of `ma_sweep/projects/projects_massbuilds.csv`, and permits from `PILOT_DATA_DIR/permits_2026/falmouth.csv` if present (else coverage `skipped`, reason `no permit file`).
  2. `kb_ingest`.
  3. Read back signals and companies.
  4. `resolveGaps` (live only with `PILOT_LIVE=1`; `wantBidPath` puts bid-path steps first).
  5. Evaluate with the campaign params and approved preferences.
  6. `kb_deliver` into the workspace as list "Piloto Falmouth · HVAC obra nova", with opportunities (`fit != 'no'`) tagged with `campaign_id`.
  7. Finish the round with summary and stop reason.
  8. Write the coverage `kb_jobs` rows.
  9. Write `PILOT_OUT_DIR/pilot-round-<n>.json`.
  It prints only counts.
- `src/lib/evals/{gold,score}.ts` (Plan B Task 1 shapes; reuse `matchCompanies` from `baseline.ts`):
  - `scoreQueue(queue, gold)` → `{ denominators, recovered, missed, falsePositives, newNotInGold, duplicates, withProof, withContactPath }`.
- `scripts/eval-falmouth.smoke.ts`, skipped unless `EVAL_RUN=1`:
  - Reads the gold Falmouth labels from `PILOT_DATA_DIR/gold/falmouth_gold.csv` (private Python export outside the repo, made by the orchestrator).
  - Reads the round files.
  - Builds the **current flow** baseline on the same rows with the existing `priorityOf`, no AI.
  - Scores both, plus round 1 vs round 2.
  - Writes `PILOT_OUT_DIR/eval-falmouth.md` and prints counts only.
- Tests (unit, invented data):
  - `scoreQueue` counts duplicates and recovered
  - env guards refuse the prod ref and a repo path
  - scripts skip without their flag

Commit: `feat(pilot): Falmouth round runner and gold evaluation`.

### Task P7: ORCHESTRATOR — local run, UI walk-through, report
- Local DB per Juan's choice.
- First access with the Air HVAC profile and only "quero mais clientes"; accept installation.
- Round 1, eval, then reopen the app and the campaign; give the multifamily instruction; round 2; eval again.
- Confirm that the other campaign's params are intact, that the preference proposal is approved and then undone, and walk `/leads/ligar`, the call facts, a logged outcome and the coverage section.
- Live permit collection (PermitEyes, US VPN), live site reads and any AI run only after Juan's explicit ok; otherwise the report states exactly what was not validated.
- Update `/Users/juansanchees/Documents/Hvac - Project/docs/contexto-geral-2026-11-18.md` and memory.


