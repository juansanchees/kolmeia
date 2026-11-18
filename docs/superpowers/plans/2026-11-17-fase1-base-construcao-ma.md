# Fase 1 — Base de construção em MA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared Kolmeia base (`kb_*`) of Massachusetts builders/GCs/developers, filled only by our own collection (Maps robot, permits, projects, crosswalk, licenses, site robot), each value with source and date, deduplicated, removable everywhere, and delivered once into the Air HVAC workspace as a normal list (`lead_imports.kind = 'kb'`).

**Architecture:** Two migrations add the `kb_*` tables (no `workspace_id`, RLS on, no policies, no grants to `anon`/`authenticated`) and four `service_role`-only SECURITY DEFINER functions: `kb_ingest` (dedupe + write), `kb_deliver` / `kb_deliver_finish` (copy into a workspace through the existing `import_rows_core`), `kb_remove` (propagate a removal to every workspace). Pure TypeScript mappers in `src/lib/kb/` turn private CSVs and site reads into ingest items; thin operator scripts in `app/scripts/kb-*.smoke.ts` (run by the existing smoke vitest config, like `baseline.smoke.ts`) read the CSVs by path, read the robot key from the macOS Keychain and call the RPCs. The Python collectors stay where they are.

**Where collectors live (decision):** Python collectors stay in `data/ma_sweep/scripts/` (private, outside git) because they hold real-data outputs and town endpoints; everything that touches the database is TypeScript in the repo, so it reuses `nameKey`/`parseCsv`/`readSite` (robots.txt, 1 req/s per host, honest UA, SSRF guard) with zero new dependencies. Moving collectors into the repo waits for Fase 3 (US server).

**Tech Stack:** Supabase Postgres (PL/pgSQL, RLS), Next.js 16 / TypeScript, vitest 5 + PGlite, `@supabase/supabase-js` (service key, scripts only), Python 3.9 stdlib + `unittest` (private collectors).

**Spec:** `docs/superpowers/specs/2026-11-17-motor-de-dados-design.md` — §6.1 (M1, Maps, M2), §6.2, §6.3, D1–D3, D5, D8–D13, §8. Not covered: Fase 0 (done), M3 (Fase 2), `kb_recipes`/AI recipes (Fase 3), §11.

## Global Constraints
- App dir `kolmeia/.claude/worktrees/f7-leads-redesign/app`; new branch `kb-fase1` cut from `leads-redesign`. Deploy and prod steps are ORCHESTRATOR-only.
- New migrations: `0040_kb_base.sql`, `0041_kb_delivery.sql` (renumber if `main` already has 0040). Each wrapped in `begin; … commit;`, re-runnable, `security definer`, `set search_path = ''`, `revoke all … from public, anon, authenticated; grant execute … to service_role`.
- REPO IS PUBLIC: no secret, no real company/person/phone/address in code, fixtures, tests or commit messages. Tests use invented names (`Acme Builders LLC`, `555-0100`-style numbers, `example.com` domains).
- Real CSVs stay in `/Users/juansanchees/Documents/Hvac - Project/data/ma_sweep/`, read at run time via `KB_DATA_DIR`; scripts refuse a `KB_DATA_DIR` inside the repo.
- Robot key: macOS Keychain, service `kolmeia-kb-robot`, account `kolmeia-prod`, read with `security find-generic-password -a kolmeia-prod -s kolmeia-kb-robot -w`. Never in code, `.env*`, logs, test output or argv echoes. Supabase URL from env `KB_SUPABASE_URL`.
- Robots (D5, BRIEF.md): public data only; no login, account, CAPTCHA, paywall; robots.txt disallow = skip and record `robots`; ≤ ~1 req/s per host, sequential; honest User-Agent (`USER_AGENT` from `src/lib/qualifier/site/reader.ts`); VPN only as "being in the US", never rotate IPs after a block.
- D8 source allowlist (exact, SQL check + TS const `KB_SOURCES`): `maps_robot`, `permit`, `project`, `crosswalk`, `license_csl`, `license_hic`, `corp_registry`, `site_robot`. Nothing from Apollo, Google Places API, Shovels, RapidAPI, nor the `build/phone_lookup_*`, `build/email_lookup_*`, `build/firms_research.csv` files (mixed third-party directories).
- D13: people carry only `name`, `title`, `license`. Never a person phone, e-mail or address. Individuals that are not a firm (`looks_like_individual = 1` and not mapped to a firm) are not loaded.
- Freshness (proposal, "?" in spec): `KB_FRESH_DAYS = { phone: 90, website: 90, signal: 30 }`, one constant in `src/lib/kb/fresh.ts`.
- Dedupe order (spec §6.2): domain (`company_domain_key`) > phone (`company_phone_key`) > `name_key` + same city (case-insensitive) > `name_key` alone only when the incoming city is null AND exactly one live company has that `name_key`. `name_key` = `nameKey()` from `src/lib/research/dedupe.ts`, computed in TS.
- License CSV schema (Task 10 writes, Task 6 reads), UTF-8, header row, this order: `source,license_type,license_number,name,firm,city,state,status,issued_date,expires_date,source_url` (`source` ∈ `license_csl|license_hic`; never a street address).
- Every task title has a "Para o Juan:" line; prod migration, every real robot run and every delivery are ORCHESTRATOR steps that need Juan's explicit ok, with a prod backup first (`/bin/zsh ~/kolmeia-backups/bin/kolmeia-backup-prod.sh`).

## Review Focus
1. Same firm spelled differently across Maps and permits (`Acme Builders, Inc` vs `ACME BUILDERS LLC`) → one `kb_companies` row with both sources' values (Task 3 test `same firm, two spellings`).
2. Two different firms with the same name in two towns, and a permit row (no city) naming them → two companies stay separate, the permit is NOT attached to either (`skipped_unmatched`) (Task 3 test `ambiguous name not attached`).
3. A license or permit record that is a person with a home address → no address and no phone stored for any person; individuals not mapped to a firm are not loaded (Task 2 constraint test + Task 6 tests `individual skipped`, `license row has no address`).
4. A removed company comes back in the next Maps/permit load → it stays out of the base and out of every workspace (Task 3 test `removed stays out`, Task 5 test `propagates to two workspaces`).
5. Delivery batch re-sent after a lost answer, or a second delivery run → no duplicate leads, one link per company per workspace (Task 4 tests `retry is idempotent`, `second delivery skips linked`).
Also pinned: `npx vitest run --config scripts/vitest.smoke.config.mts` with no filter must NOT write to prod (Task 7 test `kb scripts skip without KB_RUN`).

---

### Task 1: Check the license and company-registry sources (no code)
Para o Juan: antes de escrever robô, eu confiro nos sites oficiais do estado se dá para baixar a lista de licenças (CSL e HIC) e o registro de empresas, sem login, e escrevo um rascunho de pedido oficial caso não dê. Nada é enviado.

**Files (private, not committed):**
- Create: `data/ma_sweep/sources/licenses.md` (BRIEF honesty table)
- Create: `data/ma_sweep/sources/public-records-request-draft.md` (only if no bulk download)

- [ ] **Step 1:** For each of CSL (Construction Supervisor License; agency ? — Mass.gov Office of Public Safety and Inspection / Division of Occupational Licensure "Check a license"), HIC (Home Improvement Contractor registration; agency ? — Office of Consumer Affairs and Business Regulation) and the Secretary of the Commonwealth Corporations Division search: find the official public page from mass.gov links only, read its `robots.txt` and terms, look for a bulk download / open-data dataset (mass.gov, data.mass.gov ?). Use the public search page at most a few times by hand; submit no other form.
- [ ] **Step 2:** Write `licenses.md`: `source | agency | URL | robots.txt allows? | terms allow automated use? | bulk download? (yes/no/?) | fields shown (name, firm, city, address?, status, dates) | CAPTCHA/login? | decision (collector / records request / skip)`. Unknown = `?`.
- [ ] **Step 3:** If CSL or HIC has no bulk download: draft a MA Public Records Law request (M.G.L. c. 66 §10 ?) to the agency's Records Access Officer asking for the full active list as CSV with name, license number, firm, city, status, issue/expiry dates, explicitly NOT home street addresses. Draft only; Juan sends it himself.
- [ ] **Step 4:** Report to the orchestrator: decision per source. Corporations Division directors collector is built in Fase 1 only if this step finds a robots-allowed, no-CAPTCHA, free path; otherwise it is recorded as deferred (decision for Juan).

### Task 2: Base tables `kb_*` with RLS closed
Para o Juan: crio as tabelas da base compartilhada no banco; nenhum cliente consegue ler nada delas direto, só o robô e as funções do servidor.

**Files:**
- Create: `app/supabase/migrations/0040_kb_base.sql`
- Modify: `app/tests/db/helpers.ts` (add `service_role` actor)
- Test: `app/tests/db/kb-base.test.ts`

**Interfaces:**
- Produces in `helpers.ts`: `Actor` gains `{ role: "service_role"; headers?: Record<string, string> }`; `export const service: Actor = { role: "service_role" }`.
- Produces tables (all `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`):
  - `kb_companies(name text 1..200, name_key text 1..200, domain text, phone text, phone_key text, address text ≤300, city text ≤100, state text default 'MA', zip text ≤10, company_type text, naics text ≤6, site_read_at timestamptz, site_outcome text, updated_at timestamptz default now(), removed_at timestamptz)`; indexes on `domain`, `phone_key`, `(name_key, lower(city))`, all `where removed_at is null`.
  - `kb_people(company_id uuid not null → kb_companies on delete cascade, name text 1..200, name_key text, title text ≤120, license text ≤40, removed_at timestamptz, unique (company_id, name_key))`. No phone/email/address columns (D13).
  - `kb_values(entity text check in ('company','person'), entity_id uuid, field text, value text 1..1000, source text, source_url text ≤500 check `^https?://`, seen_at timestamptz not null, confidence text check in ('high','medium','low'))`; checks: `field in ('name','website','phone','email','address','city','state','zip','company_type','category','license','title','note')`, `entity = 'company' or field in ('name','title','license')`, `source in KB_SOURCES` (exact list in Global Constraints); unique index `(entity, entity_id, field, md5(lower(btrim(value))), source)`.
  - `kb_signals(company_id uuid → kb_companies on delete cascade, kind text check in ('permit','project'), source text check in KB_SOURCES, source_ref text 1..120, address text, town text, value_usd numeric, work_class text, use text, issued_on date, description text ≤300, source_url text, seen_at timestamptz, unique (source, source_ref))`.
  - `kb_jobs(kind text check in ('load','sites','maps','permits','licenses','projects'), source text, city text, state text default 'MA', status text check in ('running','done','failed') default 'running', progress jsonb default '{}', error text ≤300, requested_by_run uuid → research_runs on delete set null, workspace_id uuid → workspaces on delete set null, finished_at timestamptz)` (D12: both nullable; operator runs leave them null).
  - `kb_removals(kind text check in ('company','person'), company_id uuid, person_id uuid, name_key text, domain text, phone_key text, city text, reason text ≤300, channel text default 'email', handled_by text ≤80)` — keeps match keys after the row's data is deleted.
  - `kb_lead_links(workspace_id uuid → workspaces on delete cascade, lead_id uuid → leads on delete cascade, company_id uuid → kb_companies on delete cascade, import_id uuid, created_at, primary key (workspace_id, company_id))`.
- Every table: `enable row level security`, no policy, `revoke all … from public, anon, authenticated`.

- [ ] **Step 1: Failing tests** in `kb-base.test.ts`: `authenticated cannot read or write kb_*` (select on each of the 7 tables as `as(user)` → permission denied; insert → permission denied); `anon cannot read`; `service_role can insert a company`; `apollo source rejected` (insert into `kb_values` with `source = 'apollo'` → check violation; same for `places`, `shovels`, `rapidapi_b2b`); `person phone rejected` (`entity='person', field='phone'` → check violation); `kb_people has no phone/email/address column` (information_schema query returns 0 rows).
- [ ] **Step 2:** `npx vitest run tests/db/kb-base.test.ts` → FAIL (tables missing).
- [ ] **Step 3:** Write the tables part of `0040_kb_base.sql` + the `service` actor (`set local role service_role`; no JWT claim).
- [ ] **Step 4:** PASS; `npx vitest run tests/db/rls.test.ts tests/db/security.test.ts` still PASS.
- [ ] **Step 5:** Commit `feat(kb): shared base tables, RLS closed (0040)`.

### Task 3: `kb_ingest` — dedupe and write
Para o Juan: a função que recebe o que os robôs acharam, junta a mesma empresa vinda de fontes diferentes e guarda cada dado com fonte e data, sem nunca trazer de volta quem pediu remoção.

**Files:**
- Modify: `app/supabase/migrations/0040_kb_base.sql` (append)
- Test: `app/tests/db/kb-ingest.test.ts`

**Interfaces:**
- Produces `public.kb_ingest(p_items jsonb) returns jsonb` → `{created, matched, skipped_removed, skipped_unmatched, values, people, signals}`. `service_role` only. Takes `pg_advisory_xact_lock(hashtext('kb'))`.
- Item shape (TS type `KbItem`, Task 6):
```ts
type KbItem = {
  company_id?: string;          // known id (site robot): no matching
  match_only?: boolean;         // permit rows: attach to an existing company or skip, never create
  company: { name: string; name_key: string; website?: string; phone?: string; address?: string; city?: string; state?: string; zip?: string; company_type?: string };
  values: { field: string; value: string; source: KbSource; source_url?: string; seen_at: string; confidence?: "high" | "medium" | "low" }[];
  people?: { name: string; name_key: string; title?: string; license?: string; source: KbSource; source_url?: string; seen_at: string }[];
  signals?: { kind: "permit" | "project"; source: KbSource; source_ref: string; address?: string; town?: string; value_usd?: number; work_class?: string; use?: string; issued_on?: string; description?: string; source_url?: string }[];
  site_read?: { outcome: string };   // sets site_read_at = now(), site_outcome
};
```
- Rules: ≤ 500 items per call (`22023 'too many items'`); unknown keys → `22023 'invalid item'`. Matching = the Global Constraints dedupe order, live companies only, ties → oldest. Removal check before create/match: any `kb_removals` company row matching domain, phone_key, or (name_key, city) → `skipped_removed`; people whose `(company_id, name_key)` match a person removal are dropped. A matched company fills only its null canonical columns (`coalesce`); values upsert on the unique index with `seen_at = greatest(…)`, `source_url = coalesce(excluded, old)`; signals upsert on `(source, source_ref)` updating `seen_at` only; `updated_at = now()` on touch.

- [ ] **Step 1: Failing tests** (fictional data): `creates then matches by domain` (2nd item, other name, same domain → `matched = 1`, 1 row); `matches by phone`; `same firm, two spellings` (`Acme Builders, Inc` and `ACME BUILDERS LLC`, same TS `nameKey`, same city → one company, values from `maps_robot` and `permit` both kept); `name + city keeps towns apart` (same name_key, cities Worcester and Lowell → 2 companies); `ambiguous name not attached` (`match_only` permit item, no city, name_key held by 2 companies → `skipped_unmatched = 1`, no signal written); `unique name attaches` (same with 1 company → signal linked); `removed stays out` (removal row with the domain → `skipped_removed = 1`, nothing written); `removed person dropped`; `retry idempotent` (same batch twice → 1 company, values count unchanged, `seen_at` = newest); `fills nulls only` (2nd source with another phone does not change `kb_companies.phone`, adds a `kb_values` row); `501 items refused`; `authenticated cannot execute`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `feat(kb): kb_ingest with dedupe and removal check`.

### Task 4: Delivery into a workspace (`kind = 'kb'`)
Para o Juan: a função que copia empresas da base para os leads da Air HVAC como uma lista normal ("Base Kolmeia: …"), com "Desfazer" funcionando e sem duplicar quem já foi entregue.

**Files:**
- Create: `app/supabase/migrations/0041_kb_delivery.sql`
- Modify: `app/src/lib/leads/types.ts:62` (source union + `"kb"`), `app/src/lib/qualifier/cascade.ts:47` and `app/src/lib/qualifier/site-facts.ts:9` (add `"kb"` to `IMPORTED` / `IMPORT_LIKE`), `app/src/messages/pt/leads.ts:190` (`kb: "Base Kolmeia"`), `app/src/messages/en/leads.ts:193` (`kb: "Kolmeia base"`)
- Test: `app/tests/db/kb-deliver.test.ts`; extend the existing unit tests that enumerate sources if any fail.

**Interfaces:**
- 0041 re-creates, copied from 0034 with `'kb'` added and nothing else changed: constraints `lead_imports_kind` (+`'kb'`) and `lead_fields_source` (+`'kb'`); `import_rows_core` (accept `p_source = 'kb'` when `kind = 'kb'`; `kb` gets the non-file field set incl. `company_type`); `undo_lead_import` (the 4 `source in (…)` lists + `'kb'`). Same grants as 0034.
- Produces `public.kb_deliver(p_ws uuid, p_import uuid, p_list_name text, p_rows jsonb) returns jsonb` → `{import_id, new, merged, errors, skipped_removed, skipped_linked}`. `p_import` null → creates `lead_imports(workspace_id = p_ws, created_by = null, kind = 'kb', file_name = 'Base Kolmeia', list_name = p_list_name)`; non-null → must be `kind = 'kb'`, same `p_ws`, status `importing`. Each row = an `import_rows_core` row plus `kb_company_id uuid`; rows whose company is removed or already in `kb_lead_links` for `p_ws` are dropped before the core call; after it, inserts `kb_lead_links` from `lead_import_rows (import_id, row_number) → lead_id` with `on conflict do nothing`. `service_role` only.
- Produces `public.kb_deliver_finish(p_import uuid) returns void` → `status = 'done', finished_at = now()` (kind `kb` only).

- [ ] **Step 1: Failing tests:** `first delivery` (2 kb companies → import `kind='kb'`, 2 leads, 2 links, `lead_fields.source = 'kb'`); `retry is idempotent` (same rows + same `p_import` again → `new = 0`, links still 2); `second delivery skips linked` (new import, same companies → `skipped_linked = 2`, no new lead); `merges into an existing lead` (workspace already has a lead with the same website → `merged = 1`, existing values untouched, kb values added); `removed company skipped`; `undo removes kb leads and links` (`undo_lead_import` as the owner → leads gone, links gone by cascade, redelivery possible); `wrong workspace refused` (`p_import` of ws A with `p_ws` B → `22023`); `authenticated cannot call kb_deliver`; `file import still refuses source kb`.
- [ ] **Step 2:** FAIL. **Step 3:** implement migration + TS unions/labels. **Step 4:** PASS + `npx vitest run tests/db/sources-rapidapi.test.ts tests/db/lists.test.ts` PASS + `npm run typecheck`. **Step 5:** Commit `feat(kb): deliver base companies as a 'kb' list (0041)`.

### Task 5: `kb_remove` — removal valid for every workspace
Para o Juan: quando alguém pedir "me tira da lista", um comando apaga a empresa ou pessoa da base e tira o que a Kolmeia entregou dela de todos os clientes; o que o cliente tinha por conta própria fica.

**Files:**
- Modify: `app/supabase/migrations/0041_kb_delivery.sql` (append)
- Test: `app/tests/db/kb-remove.test.ts`

**Interfaces:**
- Produces `public.kb_remove(p_kind text, p_id uuid, p_reason text, p_handled_by text) returns jsonb` → `{removed: 1, leads_deleted, leads_cleaned}`. `service_role` only. `p_kind = 'company'`: insert `kb_removals` with the company's `name_key, domain, phone_key, city`; delete its `kb_values`, people (+ their values) and signals; set `removed_at` and null `domain, phone, phone_key, address, zip` (the match keys live on only in `kb_removals`); for every `kb_lead_links` row of the company in any workspace: delete that lead's `lead_fields` with `source = 'kb'`, then delete the lead if it is untouched (`status = 'new'`, `owner_id is null`, no `research_candidates`, no `lead_fields` left) else keep it (counted `leads_cleaned`); delete the links. `p_kind = 'person'`: insert removal (`person_id`, `company_id`, `name_key`); delete the person's values, set `removed_at`; on linked leads delete `source = 'kb'` `contact_name` rows equal (case-insensitive) to the person's name and the `contact_title` rows from the same import. Takes the `'kb'` lock and each workspace's `'lead:' || ws` lock.
- Decision to confirm with Juan: removal deletes what Kolmeia delivered, never the client's own data about that company.

- [ ] **Step 1: Failing tests:** `propagates to two workspaces` (same company delivered to ws A and B → both untouched leads deleted, `leads_deleted = 2`); `worked lead is cleaned, not deleted` (ws A lead in `call_list` → kb fields gone, lead stays, `leads_cleaned = 1`); `client's own values stay` (a `source='import'` phone on the lead survives); `person removal` (only that contact's kb name/title rows go, the company stays); `re-ingest after removal is skipped` (calls `kb_ingest` with the old domain → `skipped_removed = 1`); `unknown id → 22023`; `authenticated cannot call`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `feat(kb): kb_remove propagates to every workspace`.

### Task 6: Pure mappers: private CSVs → `KbItem`
Para o Juan: o tradutor que lê as planilhas que já temos (Maps, alvarás, projetos, crosswalk, licenças) e transforma em itens para a base, já jogando fora o que não pode entrar.

**Files:**
- Create: `app/src/lib/kb/types.ts`, `app/src/lib/kb/load.ts`, `app/src/lib/kb/fresh.ts`
- Test: `app/tests/unit/kb-load.test.ts`, `app/tests/unit/kb-fresh.test.ts`

**Interfaces:**
- `types.ts`: `export const KB_SOURCES = ["maps_robot","permit","project","crosswalk","license_csl","license_hic","corp_registry","site_robot"] as const; export type KbSource = typeof KB_SOURCES[number]; export type KbItem` (Task 3 shape).
- `fresh.ts`: `export const KB_FRESH_DAYS = { phone: 90, website: 90, signal: 30 } as const; export function isFresh(kind: keyof typeof KB_FRESH_DAYS, seenAt: string, now: Date): boolean`.
- `load.ts` (uses `parseCsv` from `@/lib/leads/baseline`, `nameKey` from `@/lib/research/dedupe`); each returns `{ items: KbItem[]; skipped: Record<string, number> }`:
  - `mapsItems(csv: string, seenAt: string)` — `maps/universe.csv`; keeps only `category` in `MAPS_CATEGORIES = ["General contractor","Construction company","Contractor","Real estate developer","Home builder","Custom home builder","Remodeler","Kitchen remodeler","Bathroom remodeler","Interior construction contractor","Modular home builder","Metal construction company","Steel construction company","Home and construction"]` (≈5,100 of 12,630 rows); `state` "Massachusetts" → `MA`; values `name, phone, website, address, city, zip, category` with source `maps_robot`, `source_url` = `https://www.google.com/maps/place/?q=place_id:<place_id>`.
  - `companiesItems(csv: string, seenAt: string)` — `build/companies.csv`; skip `looks_like_individual = "1"` unless `mapped_from_person = "1"` (D13, `skipped.individual`); city null; values `name`, `license` (source `permit`).
  - `permitItems(csv: string, variants: Map<string, string>)` — `permits/*.csv` (BRIEF schema); `variants` = nameKey(variant) → canonical name from `companies.csv` `variants` (split on `|`); `match_only: true`; one `signals[]` entry `kind 'permit'`, `source 'permit'`, `source_ref = <csv source>:<permit_id>`; contractor not in `variants` → `skipped.unknown_contractor`; `owner_name`/`applicant_name` never mapped.
  - `projectItems(csv: string, seenAt: string)` — `build/projects_open.csv`; one item per non-empty `general_contractor` (company_type `gc`) and `developer` (company_type `developer`), signal `kind 'project'`, `source_ref = <source>:<project_name>` (≤120).
  - `crosswalkItems(csv: string, seenAt: string)` — only `status = "unambiguous"`; `match_only: true` on the firm; one person `{name: person_display, license: license_number}` source `crosswalk`.
  - `licenseItems(csv: string, seenAt: string)` — license schema (Global Constraints); `firm` set → company (match_only false) + person; `firm` empty → `skipped.individual`; never reads an address column.
  - Shared guards: `JUNK_NAMES` = the `JUNK_EXACT` set and `JUNK_RE` from `data/ma_sweep/scripts/name_utils.py` ported verbatim (→ `skipped.junk`); any source outside `KB_SOURCES` throws.

- [ ] **Step 1: Failing tests** (inline synthetic CSV strings): `maps keeps only builder categories` (a "Roofing contractor" row → `skipped.category`); `maps state normalised`; `individual skipped` (`looks_like_individual=1`, `mapped_from_person=0`); `permit links by variant` (`ACME BLDRS` variant → canonical `Acme Builders LLC`, `match_only` true, signal `source_ref` `boston_ckan:A1`); `owner name never mapped`; `junk contractor skipped` (`HOMEOWNER`, `TOWN OF X`); `crosswalk keeps unambiguous only`; `license row has no address` (input CSV with an extra `address` column → no item contains it); `license without firm skipped`; `isFresh` boundaries (phone at 90 d → true, 90 d + 1 s → false; signal at 30 d + 1 s → false).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck. **Step 5:** Commit `feat(kb): CSV to ingest-item mappers`.

### Task 7: Operator load script (Keychain key, private data path)
Para o Juan: o comando que eu rodo no seu Mac para subir as planilhas para a base; a chave do robô fica só no Keychain e nunca aparece na tela.

**Files:**
- Create: `app/scripts/kb-env.ts`, `app/scripts/kb-load.smoke.ts`
- Modify: `app/package.json` (scripts)
- Test: `app/tests/unit/kb-env.test.ts`

**Interfaces:**
- `kb-env.ts`: `export function kbDataDir(): string` (env `KB_DATA_DIR`, must exist, throws `"KB_DATA_DIR must be outside kolmeia/ (public repo)"` when inside the repo root); `export function kbClient(): SupabaseClient` (URL from `KB_SUPABASE_URL`, key via `execFileSync("security", ["find-generic-password","-a","kolmeia-prod","-s","kolmeia-kb-robot","-w"])`, never logged; `auth: { persistSession: false }`); `export function kbRedact(s: string): string` (removes the key and any `sb_secret_…`/`eyJ…` token); `export async function withJob(kind, source, fn: (progress: (p: object) => Promise<void>) => Promise<object>)` (inserts `kb_jobs` row, updates `progress`, sets `done`/`failed` + `error` = `kbRedact(message)` ≤300).
- `kb-load.smoke.ts`: `test.skipIf(process.env.KB_RUN !== "load")`; loads in this order (dedupe depends on it): Maps → companies → permits (all `permits/*.csv`) → projects → crosswalk → licenses (if `licenses/*.csv` exist); sends `kb_ingest` in batches of 500; one `kb_jobs` row per file; prints only counts per file (`created / matched / skipped_*`).
- `package.json`: `"kb:load": "KB_RUN=load vitest run --config scripts/vitest.smoke.config.mts kb-load"`, and the same pattern for `kb:sites`, `kb:deliver`, `kb:remove`, `kb:coverage` (Tasks 8–9, 11).

- [ ] **Step 1: Failing tests:** `data dir inside repo refused`; `redact removes key-like tokens` (`sb_secret_abc123`, a 3-part `eyJ…` JWT); `kb scripts skip without KB_RUN` (source check: every `scripts/kb-*.smoke.ts` contains `test.skipIf(process.env.KB_RUN !==`); `no key literal in scripts` (no `sb_secret_`/`service_role` JWT pattern in `scripts/kb-*`).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck + `npm run lint`. **Step 5:** Commit `feat(kb): operator load script, key from Keychain`.

### Task 8: M2 site robot
Para o Juan: o robô que visita o site de cada construtora (respeitando robots.txt, 1 página por segundo) e anota telefone, e-mail, endereço, link da página de equipe e nomes com cargo que estejam escritos lá.

**Files:**
- Create: `app/src/lib/kb/sites.ts`, `app/scripts/kb-sites.smoke.ts`
- Test: `app/tests/unit/kb-sites.test.ts`

**Interfaces:**
- Consumes `readSite(website, deps)` / `SiteRead` (`src/lib/qualifier/site/reader.ts`), `nodeRawHttp` (`net.ts`), `KbItem`, `KB_FRESH_DAYS`.
- `sites.ts`: `export function siteItem(companyId: string, company: KbItem["company"], read: SiteRead, seenAt: string): KbItem` — `company_id` set, `site_read.outcome = read.outcome`; values from every page's `facts` (`phones`, `emails`, `address`/`city`/`zip`) with source `site_robot`, `source_url` = the page URL; `team_url` stored as a `note` value `"Equipe: <url>"` for the first link matching `/team|leadership|our-people|about/i`; people from `teamPeople`. `export function teamPeople(text: string): { name: string; title: string }[]` — lines of the form `Name, Title` / `Name - Title` / `Name | Title` where Name is 2–4 capitalised words and Title contains one of `TEAM_TITLES = ["President","Owner","Principal","CEO","Founder","Vice President","VP","Project Manager","Estimator","Chief Estimator","Preconstruction","Operations Manager","Superintendent","Project Executive"]`; max 20 people per site. Personal-looking e-mails are still company-site work contacts (D13); never a person phone.
- `kb-sites.smoke.ts`: `skipIf(KB_RUN !== "sites")`; selects live companies with a domain and (`site_read_at` null or older than `KB_FRESH_DAYS.website`), limit `KB_LIMIT` (default 200); sequential reads with one shared `gaps` map; `kb_ingest` every 50; progress `{done, total, ok, robots, blocked, down, phones, emails, people}`.

- [ ] **Step 1: Failing tests:** `robots outcome writes only site_read` (`outcome: "robots"`, no pages → item has `site_read`, `values: []`); `phones and emails become site_robot values with page URL`; `teamPeople finds name and title` (`"Jane Doe, Chief Estimator"` → 1; `"Call us, Today"` → 0; `"John Smith - Owner"` → 1); `teamPeople caps at 20`; `no person phone` (a person line containing a phone number → person has only name/title).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck. **Step 5:** Commit `feat(kb): site robot (M2) on the qualifier's reader`.

### Task 9: Delivery script for Air HVAC
Para o Juan: o comando que escolhe quais construtoras da base vão para a Air HVAC (por cidade/tipo, só com telefone) e cria a lista lá, com a origem de cada dado escrita na nota do lead.

**Files:**
- Create: `app/src/lib/kb/deliver.ts`, `app/scripts/kb-deliver.smoke.ts`
- Test: `app/tests/unit/kb-deliver.test.ts`

**Interfaces:**
- `deliver.ts`: `export type KbCompanyView = { id; name; name_key; domain; phone; address; city; state; zip; company_type; values: {field; value; source; seen_at}[]; signals: {kind; address; town; value_usd; work_class; use; issued_on; source; source_ref}[]; people: {name; title}[] }`; `export function deliveryRow(c: KbCompanyView, row: number): object` → `{row, kb_company_id, name, name_key, website?, phone?, address?, city?, state?, zip?, company_type?, contact_name?, contact_title?, note}`; website = `https://<domain>`; contact = first person with a title; `note` (≤1000, cut at a line end) = up to 3 newest signals, one per line `Alvará dd/mm/aaaa · <address>, <town> · US$ <value pt-BR> · <work_class>/<use>` (`Projeto` for projects), then `Fontes: <distinct source labels> · visto em dd/mm/aaaa` (labels: `maps_robot` "Google Maps (robô próprio)", `permit` "alvará", `project` "projeto público", `crosswalk` "licença (crosswalk)", `license_csl` "licença CSL", `license_hic` "registro HIC", `corp_registry` "registro estadual", `site_robot` "site da empresa"). `export function listName(label: string, day: Date): string` → `Base Kolmeia: <label ≤60> (dd/mm)`.
- `kb-deliver.smoke.ts`: `skipIf(KB_RUN !== "deliver")`; env `KB_WORKSPACE` (uuid, required), `KB_TOWNS` (comma list, optional), `KB_TYPES` (optional), `KB_LIMIT` (required, ≤5000), always `phone is not null`; reads companies + values + signals + people with the service client; `kb_deliver` in batches of 500 reusing the returned `import_id`; `kb_deliver_finish`; prints the 6 counts.

- [ ] **Step 1: Failing tests:** `note lists newest 3 signals` (4 signals → 3 lines, newest first); `note under 1000 chars`; `US$ formatted pt-BR` (`95750` → `US$ 95.750`); `sources line uses labels`; `contact is first titled person`; `listName format` (`Base Kolmeia: Worcester (18/11)`); `no person phone or address in the row`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck. **Step 5:** Commit `feat(kb): delivery script and lead note`.

### Task 10: License collector (Python, private) — only if Task 1 found a path
Para o Juan: se o estado liberar a lista de licenças (download ou resposta ao pedido oficial), este leitor transforma o arquivo no formato da base, sem endereço de casa.

**Files (private, not committed):**
- Create: `data/ma_sweep/scripts/licenses_parse.py`, `data/ma_sweep/scripts/test_licenses_parse.py`
- Output: `data/ma_sweep/licenses/<source>.csv` (license schema, Global Constraints)

**Interfaces:**
- `parse_licenses(path: str, source: str) -> list[dict]` (columns per the schema; input column names mapped per Task 1 findings; street address columns dropped); `main()` writes the CSV and prints row counts. Python 3.9 stdlib only; if Task 1 found a download URL, `fetch(url, out)` with `urllib.request`, UA `Mozilla/5.0 (research; public records)`, robots.txt checked first, ≤1 req/s.

- [ ] **Step 1: Failing tests** (`unittest`, synthetic rows): `drops street address`, `keeps firm and city`, `status normalised to active/inactive`, `rejects unknown source`.
- [ ] **Step 2:** `python3 -m unittest data/ma_sweep/scripts/test_licenses_parse.py` → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** No commit (private folder). Real download = Task 12 step.

### Task 11: Removal channel, privacy page, bot page
Para o Juan: uma página pública de privacidade com o e-mail para pedir remoção, a página que o robô cita no "cartão de visita" dele, e o comando que eu uso para atender um pedido.

**Files:**
- Create: `app/src/app/site/privacidade/page.tsx`, `app/src/app/bot/page.tsx` (`redirect("/site/privacidade#robo")`), `app/src/messages/pt/privacy.ts`, `app/src/messages/en/privacy.ts`, `app/scripts/kb-remove.smoke.ts`
- Modify: `app/src/lib/supabase/proxy.ts:9` (`PUBLIC_PATHS` + `"/bot"`), `app/src/app/site/page.tsx` footer (link "Privacidade"), `app/src/messages/{pt,en}/index.ts`, `app/src/messages/{pt,en}/landing.ts` (`footer.privacy`)
- Test: `app/tests/unit/proxy-landing.test.ts` (extend), `app/tests/unit/privacy-page.test.ts`

**Interfaces:**
- Privacy copy (pt, en mirrors, `satisfies Widen<typeof pt>`): what the base holds (company data and work contacts from public sources, each with source and date), what it never holds (home address, personal phone not published as a work contact), how to ask removal: e-mail `KB_REMOVAL_EMAIL` (address = **?**, Juan confirms the mailbox exists), answered by hand, valid for every client. Section `id="robo"`: the User-Agent string, robots.txt honoured, ≤1 request/s per site. Never the word "LinkedIn".
- `kb-remove.smoke.ts`: `skipIf(KB_RUN !== "remove")`; env `KB_REMOVE_KIND`, `KB_REMOVE_ID`, `KB_REMOVE_REASON`; calls `kb_remove(…, p_handled_by = "operator")`; prints the 3 counts.
- D13 DNC: no new code — check `CallFacts.tsx` shows `calls.b2bOnly` ("Número residencial: checar a lista Do Not Call antes.") on the call screen.

- [ ] **Step 1: Failing tests:** `/bot is public` (anonymous `/bot` → no redirect to `/login`); `/site/privacidade is public`; `privacy page has the removal e-mail and #robo` (source/render check); `USER_AGENT url points to /bot` (`reader.ts` UA contains `kolmeia.solutions/bot`).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck + lint; `grep -n "b2bOnly" src/components/calls/CallFacts.tsx` → 1 hit. **Step 5:** Commit `feat(site): privacy page, bot page, removal command`.

### Task 12: ORCHESTRATOR — prod setup (needs Juan's ok)
Para o Juan: com seu ok, faço backup do banco de produção, aplico as duas migrações e você cria a chave do robô e guarda no Keychain (só você cola a chave).

- [ ] Full gate locally: `npm run check` PASS on `kb-fase1`.
- [ ] **ORCHESTRATOR — needs Juan's ok:** `/bin/zsh ~/kolmeia-backups/bin/kolmeia-backup-prod.sh`, then apply `0040_kb_base.sql`, `0041_kb_delivery.sql` to prod (`qkrlfmtmvllugkgvafxt`); check `select count(*) from public.kb_companies` = 0 and an authenticated select is denied.
- [ ] **JUAN:** create a dedicated Supabase secret key named `kb-robot` (Dashboard → API keys; whether the project uses new `sb_secret_` keys or only the legacy `service_role` JWT = **?**) and store it: `security add-generic-password -a kolmeia-prod -s kolmeia-kb-robot -w` (prompted, not typed in chat).
- [ ] Merge to `main` and deploy (privacy and bot pages); check `https://kolmeia.solutions/site/privacidade` and `/bot` open logged out.

### Task 13: ORCHESTRATOR — robot runs, load, first delivery, coverage (each needs Juan's ok)
Para o Juan: cada rodada de robô e a entrega para a Air HVAC só acontecem depois do seu ok, uma por vez, com a contagem no fim.

- [ ] **Needs Juan's ok — permits with US VPN:** re-run the existing `data/ma_sweep/scripts/*_probe.py`/town scripts for towns marked blocked-by-IP or not checked in `sources/*.md`; robots.txt-blocked towns stay blocked; update the honesty tables.
- [ ] **Needs Juan's ok — Maps robot:** `maps_driver.py` for towns not yet run (number of towns per run = Juan decides; volume low), then `maps_merge.py`.
- [ ] **Needs Juan's ok — licenses:** per Task 1 decision (download via Task 10, or wait for the records-request answer Juan sent).
- [ ] **Needs Juan's ok — load:** `KB_DATA_DIR=… KB_SUPABASE_URL=… npm --prefix app run kb:load`; expect Maps ≈5,100 items created/matched, permit signals attached, counts recorded.
- [ ] **Needs Juan's ok — sites:** `KB_LIMIT=200 npm --prefix app run kb:sites` first; check `robots`/`blocked` counts before larger runs.
- [ ] **Needs Juan's ok — first delivery:** size and towns chosen by Juan (every delivered lead enters the Qualificador queue): `KB_WORKSPACE=<Air HVAC ws id ?> KB_LIMIT=<n> npm --prefix app run kb:deliver`; open LEADS in Juan's session, check the list "Base Kolmeia: …", phone + note with sources, "Desfazer" available.
- [ ] **Coverage:** Census CBP MA establishments NAICS 23 via `curl "https://api.census.gov/data/<year ?>/cbp?get=ESTAB&for=state:25&NAICS2017=23"` (latest year = **?**); report kb companies (total, with phone, with a signal ≤30 d, phone ≤90 d per `KB_FRESH_DAYS`) against that total. Counts only; no lead data in the repo.
