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

Commit: `feat(offers): reusable offer rule (hvac_new_construction), gap resolver, coverage`.

### Task P4: Screens — call facts, coverage, agent offer
Para o Juan: na ficha de ligação aparece a obra, a data com link da fonte, o motivo, o contato, o gancho e as perguntas; na Cobertura aparece cada cidade e fonte com o motivo do que faltou; no agente dá para escolher a oferta.

- `CallFacts.tsx` (and the lead modal's facts if they share data) shows the top open opportunity:
  - title, date + source link, priority reasons (from codes via messages), contact path (phone / "Cadastro de fornecedor" link / bids page), `hookEn` (lang="en"), and open questions (codes via messages).
  - Data is loaded in the existing lead-detail query path.
- Coverage page `/leads/cobertura`: add a section "Por fonte" with one row per (town, source): date, outcome badge, entered count and reason.
  - Read it through a new `security definer` function `kb_coverage(p_ws uuid)` (in 0041), which checks membership and returns operator rows (null workspace) plus that workspace's rows.
  - A non-member gets a permission error.
- Agent setup: add `offer` (select from `OFFERS`, default none) to `HunterSetup`, the wizard and the agent detail. Stored in the config. The AI run is unchanged.
- pt/en messages in parity; Plan A Task 10 `/bot` page as specified there.
- Tests: render/source tests in the style of existing component tests, the parity test, and `kb_coverage` membership tests.

Commit: `feat(ui): opportunity facts on the call screen, coverage by source, agent offer`.

### Task P5: Pilot runner and evaluation scripts
Para o Juan: um comando roda o piloto de Falmouth com os dados que já temos e outro compara o resultado com a lista padrão-ouro, sem a lista padrão-ouro entrar no agente.

- `scripts/pilot-env.ts`:
  - Guards for `PILOT_DATA_DIR`/`PILOT_OUT_DIR` outside the repo and the DB URL rule.
  - Service key from Keychain service `kolmeia-pilot-local` (account `kolmeia-pilot`) or env `PILOT_SERVICE_KEY` for a local Supabase only.
- `scripts/pilot-falmouth.smoke.ts`, skipped unless `PILOT_RUN=1`. Steps:
  1. Load Falmouth rows from `ma_sweep/maps/raw/falmouth.csv`, Falmouth rows of `ma_sweep/projects/projects_massbuilds.csv`, and permits from `PILOT_DATA_DIR/permits_2026/falmouth.csv` if present (else coverage `skipped`, reason `no permit file`).
  2. `kb_ingest`.
  3. Read back signals and companies.
  4. `resolveGaps` (live only with `PILOT_LIVE=1`).
  5. `getOffer('hvac_new_construction').evaluate`.
  6. `kb_deliver` into `PILOT_WORKSPACE_ID` as list "Piloto Falmouth · HVAC obra nova" with opportunities where `fit != 'no'`.
  7. Write coverage `kb_jobs` rows.
  8. Write `PILOT_OUT_DIR/pilot-run.json` (counts, coverage, per-opportunity verdicts).
  It prints only counts.
- `src/lib/evals/{gold,score}.ts` (Plan B Task 1 shapes; reuse `matchCompanies` from `baseline.ts`):
  - `scoreQueue(queue, gold)` → `{ denominators, recovered, missed, falsePositives, newNotInGold, duplicates, withProof, withContactPath }`.
  - Company match by name_key / domain / phone.
- `scripts/eval-falmouth.smoke.ts`, skipped unless `EVAL_RUN=1`:
  - Reads gold Falmouth labels from a CSV export at `PILOT_DATA_DIR/gold/falmouth_gold.csv`, made by a private one-off Python export outside the repo.
  - Reads `pilot-run.json`.
  - Builds the **current flow** baseline locally: the same Maps + projects rows ranked by the existing `priorityOf` (`src/lib/leads/classify.ts`), no AI.
  - Scores both and writes `PILOT_OUT_DIR/eval-falmouth.md`.
  - Separates `newNotInGold` for manual review.
  - Prints only counts.
- Tests (unit, invented data):
  - `scoreQueue` counts duplicates and recovered
  - env guards refuse prod ref and a repo path
  - both scripts skip without their flag

Commit: `feat(pilot): Falmouth pilot runner and gold evaluation`.

### Task P6: ORCHESTRATOR — local run, UI walk-through, report
- Local DB per Juan's choice.
- Run the pilot twice (second run = idempotency proof).
- Run the eval.
- Walk the UI: agent with the offer, `/leads/ligar`, a call facts screen, the coverage section, and a logged outcome.
- Live permit collection (PermitEyes with the US VPN), live site reads and any AI baseline run happen only after Juan's explicit ok. Otherwise the report says exactly what was not validated.
- Update `/Users/juansanchees/Documents/Hvac - Project/docs/contexto-geral-2026-11-18.md` and memory.
