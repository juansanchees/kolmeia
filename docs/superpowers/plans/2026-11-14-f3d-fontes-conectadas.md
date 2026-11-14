# F3d Fontes conectadas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each workspace connects its own Apify and Apollo keys; Google Maps (Apify) and Apollo searches, manual or started by a Caçador, become leads through the F3c-1 import path with source and date on every value, inside a per-workspace daily cap; later (F3d-2) the Apify contact scraper fills e-mails the free site reader missed.
**Architecture:** Migration 0014 adds `source_connections` (encrypted key, last 4, caps), `agent_source_settings`, `source_runs` (one row per external run = the sources ledger), `lead_imports.kind`, wider `lead_fields.source`, an internal `import_rows_core` that F3c-1's `import_lead_rows` now wraps, and a token-gated `source_*` path like F3b's `hunter_*`. Screens only enqueue; `runSourceTick` (inside F3b's cron route) starts Apify runs, polls them by run id on later ticks, fetches dataset items, maps and imports them; Apollo runs complete in one tick. F3d-2 (migration 0015, after F3c-2) adds the P2b contact step and the sources rows in Gastos.
**Tech Stack:** Next.js 16.4.5 App Router, React 19.3, TypeScript, zod 4, Supabase/Postgres (PGlite in tests), `fetch` behind an injected `HttpJson` seam, vitest (node env).
**Spec:** `kolmeia/docs/superpowers/specs/2026-11-14-f3d-fontes-conectadas-design.md` (S-1..S-8, sections 3-8). Builds on `2026-11-14-f3c-1-subir-lista.md` and (Task 8 only) `2026-11-14-f3c-2-qualificador.md`.

`APP` = `kolmeia/app`. Every command runs from `APP`.

## Global Constraints
- Requires F3b and F3c-1 merged (0010, 0011). Names from them are marked **(confirmar após F3b/F3c-1)**: open the merged code and adapt; never fork. Tasks 1-7 (F3d-1) use nothing from 0012/0013. Task 8 is **depende da F3c-2**.
- Baseline: Task 1 Step 1 records `npx vitest run` as `B`.
- Providers: `apify`, `apollo`. Run kinds: `maps` (Apify `compass~crawler-google-places`), `apollo` (Apollo free organization lookup), `contact` (Apify `vdrmota~contact-info-scraper`, Task 8 only). No other actor.
- Keys (S-2): `encryptSecret`/`decryptSecret` from `src/lib/email/crypto.ts` with new `sourceAad(ws, provider) = "source:" + ws + ":" + provider`. Ciphertext never selected by clients. A key never appears in logs, thrown messages, RPC results, URLs or HTML; Apify auth by header `Authorization: Bearer`, Apollo by header `X-Api-Key` (?). UI shows `••••` + last 4.
- Caps (spec 5): `apify.daily_cap_usd` default 2.00, range 0.50..50; `apollo.daily_calls` default 20, range 1..200. Day = midnight America/New_York (own SQL helper `source_day_start()`; do NOT use 0012's). Spent today (Apify) = sum over today's `source_runs` of `greatest(reserve_usd, coalesce(cost_usd,0))` for `queued|running`, `cost_usd` for finished. A run whose reserve passes the cap is refused at enqueue (`source_cap`) and at start.
- Maps input (spec 3, verbatim): `searchStringsArray`, `locationQuery`, `maxCrawledPlacesPerSearch = ceil(max / terms.length)`, `language "en"`, `skipClosedPlaces true`, `scrapePlaceDetailPage false`, `scrapeContacts false`; query params `maxTotalChargeUsd = mapsReserve(max)`, `timeout=600`. `MAPS_USD_PER_PLACE = 0.004` (?), `APIFY_MIN_CHARGE_USD = 0.50`, `mapsReserve(max) = max(0.50, ceil(max * 0.004 * 100) / 100)`. `max` 1..200 (default 50); terms 1..5, each ≤ 80 chars; location ≤ 120.
- Apify REST (?) : start `POST https://api.apify.com/v2/acts/{actor}/runs?maxTotalChargeUsd=…&timeout=600` → `data.id`, `data.defaultDatasetId`; poll `GET /v2/actor-runs/{id}` → `data.status` ∈ READY, RUNNING, SUCCEEDED, FAILED, ABORTED, TIMED-OUT, ABORTING, TIMING-OUT, `data.usageTotalUsd`; items `GET /v2/datasets/{id}/items?clean=true&format=json&limit={max}`; abort `POST /v2/actor-runs/{id}/abort`; key test `GET /v2/users/me`. Timeout per HTTP call 10 s. Stale: running > 15 min → abort, `failed 'stale'`.
- Apollo (?): free lookup = `POST https://api.apollo.io/api/v1/mixed_companies/search` with `display_mode: "fuzzy_select_mode"`, `organization_locations`, `organization_naics_codes`, `page`, `per_page 25` — **Task 5 Step 0 confirms path, auth header and response keys with Juan's key (one real call, by Juan/Claude by hand, not in tests); adjust constants only**. Never call `mixed_companies` without `fuzzy_select_mode`, never enrich. Junk drop: TLD is a 2-letter ccTLD other than `us`, or no domain and no website.
- Import (S-4): results enter as `lead_imports (kind 'apify_maps'|'apollo', list_name "Maps · {label} · dd/mm" / "Apollo · {label} · dd/mm", file_name "Google Maps (Apify)" / "Apollo")`, rows through `import_rows_core(p_import, p_rows, p_source)` with `p_source` `apify_maps`|`apollo`; same `find_lead`, lock, K-2 merge, undo. Undo and history of F3c-1 work for these imports unchanged. Values keep `seen_at` = run finish time.
- Roles: owner only sets/deletes connections and caps; owner/sdr enqueue searches and edit agent source settings; closer sees nothing of sources.
- Tick: `SOURCE_TICK_BUDGET_MS = 30_000`, `SOURCE_MAX_STARTS = 3`, `SOURCE_MAX_POLLS = 10` per tick; runs after the Caçador (and after the Qualificador when F3c-2 is merged). Lease 330 s in `source_ticks`. No new cron.
- Copy (pt-BR, short; never "pearchat"): new `src/messages/pt/sources.ts` (`t.sources`). Verbatim: `title: "Fontes conectadas"`, `mapsTerms: "A coleta do Google Maps segue os termos do Google. O responsável é o dono do workspace."`, `apolloTerms: "Os dados do Apollo ficam só neste workspace. Não revendemos nem compartilhamos."`, `noLinkedin: "Sem LinkedIn: links do LinkedIn são descartados."`, `keyMasked: "••••{last4}"`, `keyBad: "Chave recusada pelo serviço. Confira e cole de novo."`, `todayUsd: "Hoje: US$ {spent} de {cap}"`, `todayCalls: "Hoje: {n} de {cap} buscas"`, `searchMaps: "Buscar no Maps"`, `searchApollo: "Buscar no Apollo"`, `estimate: "até US$ {usd}"`, `queued: "na fila"`, `running: "rodando"`, `capHit: "Teto do dia atingido. Volta à meia-noite (Nova York)."`, `notConnected: "Conecte a chave em Configurações › Fontes conectadas."`.
- Reuse, do not fork: `encryptSecret`/`decryptSecret`/`SecretError`, `sanitizeUrl`/`hostOf`, `nameKey`/`domainKey`/`phoneKey`, `RpcFn`/`supabaseRpc`/`HunterAuthError`/`pgRpc`, tick/lease pattern, `scheduler_authorized()`, `AutoRefresh`, `Notice`, `usd`, `date`, F3c-1 `ImportRowIn`, `ImportHistory`, `undo_lead_import`.
- Migration `supabase/migrations/0014_sources.sql`: re-runnable style of 0010/0011; `security definer`, `set search_path = ''`; `source_*` token functions granted to `anon` only; session RPCs to `authenticated`; unknown JSON keys → 22023; `workspace_id` always from the row, never from a payload. Applying it = manual checklist; order 0014 → code.
- Tests never touch the network: fake `HttpJson`. Fixtures synthetic only (`*.example`, `508-555-01xx`, fake keys `apify_api_TESTKEY0000`).
- Next 16 (`APP/AGENTS.md`): before Task 3 and Task 7 read `node_modules/next/dist/docs/` on server actions and forms.
- Git: public repo; one commit per task, given message + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit keys, `.env*`, real results. No push/deploy. Ledger `kolmeia/.superpowers/sdd/f3d/progress.md`.

## Review Focus
1. **A key leaks through an error path** (Apify answers 401 with the request echoed; a thrown fetch error; the RPC that lists connections). Expect no key bytes in any thrown message, result, log line or page HTML. Owners: Task 3 (`saving a refused key returns keyBad and the error carries no key`), Task 4 (`apify errors never contain the token`), Task 1 (`clients never read secret_ciphertext`).
2. **The run finishes on Apify but the tick dies before importing** (route timeout, deploy). Expect the next tick to see `SUCCEEDED`, import once, and a third tick to do nothing (no double import, no double charge). Owner: Task 6 (`a succeeded run is imported exactly once across ticks`).
3. **Two "Buscar no Maps" clicks at once near the cap** (cap 2.00, spent 1.20, each reserve 0.50). Expect the second refused `source_cap`, never both. Owner: Task 1 (`concurrent enqueues cannot pass the daily cap`).
4. **Apify bills more than reserved or reports no cost** (`usageTotalUsd` missing, or 0.63 > 0.50). Expect cost = reported value when present (and the next enqueue sees it), else = reserve. Owner: Task 6 (`settle uses usageTotalUsd, else the reserve`).
5. **Garbage rows** (Maps place in Canada, permanently closed, LinkedIn as website, no name; Apollo `.co.uk`, `.com.pk`, no domain). Expect dropped before import, counted as `dropped` on the run, no lead. Owners: Task 4 (`mapPlace drops non-US, closed, nameless; strips LinkedIn`), Task 5 (`apollo junk filter drops foreign ccTLDs and domainless rows`).

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/supabase/migrations/0014_sources.sql` (T1, T2) | tables, caps, session RPCs, import core (T1); token path (T2) |
| `APP/tests/db/sources.test.ts`, `tests/db/sources-path.test.ts`, `tests/db/sources-seed.ts` | DB rules |
| `APP/src/lib/sources/{types,http,apify,maps,apollo}.ts` (T4, T5) | clients + pure mapping |
| `APP/src/lib/sources/{connections,store,tick}.ts`, route (T3, T6) | keys, token store, tick |
| `APP/src/app/(app)/configuracoes/fontes/{page,actions}.tsx` (T3), `src/app/(app)/leads/buscar/{page,actions}.tsx`, `src/components/sources/*` (T7) | screens |
| `APP/supabase/migrations/0015_source_contacts.sql`, `src/lib/sources/contact.ts`, qualifier + spend edits (T8) | F3d-2 |

---

### Task 1: Migration 0014 — connections, ledger, caps, import core

**Files:** Create `supabase/migrations/0014_sources.sql`, `tests/db/sources.test.ts`, `tests/db/sources-seed.ts`.
**Interfaces:**
- `source_connections (workspace_id → workspaces on delete cascade, provider text check in ('apify','apollo'), secret_ciphertext text 20..1000, last4 text check ~ '^[A-Za-z0-9]{4}$', daily_cap_usd numeric(8,2) null, daily_calls int null, created_by uuid, updated_at, primary key (workspace_id, provider))`; checks: apify → cap in 0.50..50, apollo → calls in 1..200. RLS: no client SELECT on the table; view-free RPC `list_source_connections(p_ws) returns table(provider, last4, daily_cap_usd, daily_calls, spent_today_usd, calls_today, updated_at)` (sender).
- `set_source_connection(p_ws uuid, p_provider text, p_ciphertext text, p_last4 text, p_cap numeric) returns void` (owner; upsert; `p_cap` = USD for apify, calls for apollo); `set_source_cap(p_ws, p_provider, p_cap)` (owner); `delete_source_connection(p_ws, p_provider)` (owner; queued runs of that provider → `refused 'disconnected'`); `source_secret(p_ws uuid, p_provider text) returns text` (owner only; used to test-save, never sent to the browser).
- `agent_source_settings (agent_id pk → agents on delete cascade, workspace_id, maps_on bool default false, maps_terms text[] 1..5, maps_location text ≤120, maps_max int 1..200 default 50, apollo_on bool default false, apollo_locations text[] ≤5, apollo_naics text[] ≤5 each ~ '^[0-9]{2,5}$', apollo_pages int 1..4 default 1)`; select = sender; write via `set_agent_source_settings(p_agent uuid, p jsonb)` (sender of the agent's workspace).
- `source_runs (id, workspace_id, provider, kind check in ('maps','apollo','contact'), agent_id null, research_run_id null, requested_by null, query jsonb ≤4000 bytes, max_results int, reserve_usd numeric(8,2) not null default 0, cost_usd numeric(8,2), status check in ('queued','running','succeeded','imported','failed','refused'), external_run_id text, dataset_id text, error text ≤60, found int, dropped int, import_id → lead_imports on delete set null, created_at, started_at, finished_at)`; unique `(research_run_id, kind)` where not null. Select = sender. Function `source_day_start() returns timestamptz` (NY midnight), `source_spent_today(p_ws) returns numeric`, `source_calls_today(p_ws) returns int`.
- `enqueue_source_run(p_ws uuid, p_kind text, p_query jsonb, p_max int) returns uuid` (sender; connection required else `source_not_connected` 22023-coded P0001; validates query keys per kind; under lock `'source:' || ws`: reserve = `mapsReserve` for maps, 0 for apollo; spent + reserve > cap (or calls_today ≥ daily_calls) → raise `source_cap`; inserts `queued`).
- `lead_imports.kind text not null default 'file' check in ('file','apify_maps','apollo')`; `lead_fields.source` check adds `'apify_maps','apollo','apify_contact'`; `import_rows_core(p_import uuid, p_rows jsonb, p_source text) returns jsonb` (internal, no grant; F3c-1's body moved here, row keys add `place_id`, `company_type`); `import_lead_rows` re-created = auth checks + `import_rows_core(..., 'import')` **(confirmar após F3c-1: copy merged body)**.
- Seed: `seedSources(db, opts?: { apifyCap?: number; apolloCalls?: number }): Promise<{ ws: string; owner: string; sdr: string; closer: string }>` (connections with a dummy ciphertext).

- [ ] Step 1: Baseline `npx vitest run` → `B`. Create the ledger.
- [ ] Step 2: Write `tests/db/sources.test.ts`:
  - `clients never read secret_ciphertext; list_source_connections shows last4 and today's spend only`.
  - `only the owner sets, caps or deletes a connection; sdr and closer get 42501; caps out of range → 23514`.
  - `enqueue refuses without a connection (source_not_connected) and past the cap (source_cap)` — cap 2.00, maps max 50 → reserve 0.50; 4 ok, 5th refused; apollo calls cap 2 → 3rd refused.
  - `concurrent enqueues cannot pass the daily cap` — two sessions, spent 1.20, both enqueue → exactly one ok.
  - `the day resets at New York midnight, not UTC` — admin back-dates runs to 23:30 NY yesterday → not counted.
  - `a finished run counts its cost, a queued one its reserve`.
  - `import_lead_rows is unchanged for files (F3c-1 tests green) and import_rows_core writes the given source` — core with `apify_maps` → fields `source 'apify_maps'`, `source_ref` = import id; `place_id` and `company_type` stored.
  - `undo of an apify_maps import removes only its leads` (reuse F3c-1 K-9 shape, one case).
  - `the closer sees no source_runs and no agent_source_settings`.
- [ ] Step 3: Run `npx vitest run tests/db/sources.test.ts` → FAIL.
- [ ] Step 4: Write the T1 part of `0014_sources.sql` and the seed.
- [ ] Step 5: Run → PASS; `npx vitest run` → `B + 9`, `lists.test.ts` green unchanged.
- [ ] Step 6: Commit `feat(db): 0014 connected sources: encrypted keys, daily caps on a ledger, one import core for files and sources`.

### Task 2: Migration 0014 — token-gated `source_*` path

**Files:** Modify `supabase/migrations/0014_sources.sql` (append), `tests/engine/pg-rpc.ts` (pattern `^(hunter|qualifier|source)_[a-z_]+$`, **confirmar após F3b**). Create `tests/db/sources-path.test.ts`.
**Interfaces:** (each: `scheduler_authorized()` first else 42501; granted to anon only)
- `source_ticks` (shape of `hunter_ticks`); `source_begin_tick() returns jsonb {tick_id, busy}`; `source_finish_tick(p_tick, p_counts jsonb, p_error text)`.
- `source_enqueue_agent_runs(p_tick) returns int` — for each research run of an agent (status running, created < 24 h, **confirmar após F3b** column names) whose `agent_source_settings` has `maps_on`/`apollo_on` and whose workspace has that connection: insert one `queued` run per kind (`on conflict (research_run_id, kind) do nothing`), query from settings, label = agent name; cap refusal → `refused 'source_cap'` row (shown in history).
- `source_next_work(p_tick) returns jsonb` → `{ start: [SourceRunRow ≤3, oldest queued, re-checks cap], poll: [SourceRunRow ≤10, running, oldest started] }`; `SourceRunRow = { id, workspace_id, provider, kind, query, max_results, reserve_usd, external_run_id, dataset_id, started_at, label, ciphertext }` (ciphertext of that workspace+provider; null → run becomes `refused 'disconnected'`).
- `source_mark_started(p_tick, p_run, p_external_id text, p_dataset text) returns void` (`queued → running`); `source_mark_failed(p_tick, p_run, p_error text, p_cost numeric)`; `source_import(p_tick, p_run, p_rows jsonb, p_found int, p_dropped int, p_cost numeric) returns jsonb` — only from `running` or `succeeded` without `import_id` (else 22023, guarantees once); creates `lead_imports (kind, created_by = requested_by, list_name, file_name, status 'done')`, calls `import_rows_core` in chunks of 500 with source per kind, sets `import_id`, `cost_usd`, `found`, `dropped`, `status 'imported'`, `finished_at`. Returns `{ new, merged }`.

- [ ] Step 1: Write `tests/db/sources-path.test.ts`:
  - `every source_* entry point refuses no token and a wrong token (42501); users cannot execute them`.
  - `one source tick at a time; an expired lease frees it`.
  - `agent runs enqueue one maps and one apollo search each, once` — second call → 0 new rows.
  - `next_work re-checks the cap and refuses runs of a disconnected workspace`.
  - `source_import creates a Maps import, dedupes against existing leads and cannot run twice` — second call → 22023.
  - `mark_failed settles the cost and frees the reserve`.
- [ ] Step 2: Run → FAIL. Step 3: append T2 SQL; widen `pgRpc`. Step 4: Run → PASS; `npx vitest run` → `B + 15`.
- [ ] Step 5: Commit `feat(db): token-gated sources path: enqueue from Caçador runs, start, poll, import once`.

### Task 3: Keys and the Fontes conectadas screen

**Files:** Modify `src/lib/email/crypto.ts` (add `sourceAad`), `src/lib/nav.ts` (`SETTINGS_TABS` + `{ href: "/configuracoes/fontes", label: t.settings.nav.sources }`), `src/messages/pt/{index,common}.ts`. Create `src/lib/sources/connections.ts`, `src/messages/pt/sources.ts`, `src/app/(app)/configuracoes/fontes/{page.tsx,actions.ts}`, `src/components/sources/ConnectionCard.tsx`, `tests/unit/sources-connections.test.ts`. Modify `tests/unit/{nav,guards}.test.ts`.
**Order:** run this task after Tasks 4 and 5 (it consumes `apifyClient(...).checkKey()` and `apolloClient(...).checkKey()` and `HttpJson`); numbering kept for review.
**Interfaces:**
- `connections.ts` (`server-only`): `type Provider = "apify" | "apollo"`; `last4(key: string): string`; `validateKeyShape(p: Provider, key: string): boolean` (trimmed, 16..200 chars, `[A-Za-z0-9_\-]`); `testKey(p: Provider, key: string, http: HttpJson): Promise<"ok" | "refused" | "unreachable">` (Task 4/5 clients' `checkKey`); `sealKey(ws: string, p: Provider, key: string): string` = `encryptSecret(key, sourceAad(ws, p))`; `openKey(ws, p, ciphertext): string`.
- Actions: `saveSourceKey(prev, form)` → test then `set_source_connection`; `saveSourceCap`, `deleteSourceKey` (two-step confirm). Owner only (`requireSender` + role check); results `{ ok } | { error: keyof t.sources.errors }` — never the key.
- Page: two `ConnectionCard`s (masked key, cap field, today's spend, terms copy, [Trocar chave] [Desconectar]); sdr read-only; closer → not found.

- [ ] Step 1: Tests: `sourceAad binds workspace and provider: a key sealed for apify does not open as apollo`; `last4 and masking`; `saving a refused key returns keyBad and the error carries no key` (fake http 401 echoing the key; assert result JSON excludes key); `the settings nav lists Fontes conectadas for owner and sdr, not closer`; `guards: src/lib/sources is server-only and the bundle check forbids api.apify.com and api.apollo.io`.
- [ ] Step 2: FAIL → Step 3: implement → Step 4: PASS, `B + 31` (after Tasks 4-5).
- [ ] Step 5: Commit `feat(sources): connect your own Apify and Apollo keys, encrypted, last 4 only`.

### Task 4: Apify client and Google Maps mapping

**Files:** Create `src/lib/sources/{types,http,apify,maps}.ts`, `tests/unit/sources-apify.test.ts`, `tests/unit/sources-fakes.ts`.
**Interfaces:**
- `http.ts`: `interface HttpJson { request(method: "GET" | "POST", url: string, o: { headers: Record<string, string>; body?: unknown; timeoutMs: number }): Promise<{ status: number; json: unknown }> }`; `fetchHttpJson: HttpJson` (timeout via `AbortSignal.timeout`; errors re-thrown as `SourceHttpError(code: "timeout" | "network" | "bad_json")` with no URL query or headers in the message).
- `apify.ts`: `apifyClient(token: string, http: HttpJson)` → `{ checkKey(): Promise<"ok"|"refused"|"unreachable">; start(actor: string, input: object, maxChargeUsd: number): Promise<{ runId: string; datasetId: string }>; status(runId: string): Promise<{ status: ApifyStatus; usageUsd: number | null }>; items(datasetId: string, limit: number): Promise<unknown[]>; abort(runId: string): Promise<void> }`; `ApifyError(code: "refused" | "http_<status>" | "bad_response")`. Values per Global Constraints "Apify REST".
- `maps.ts` (pure): `MAPS_ACTOR = "compass~crawler-google-places"`; `mapsReserve(max: number): number`; `mapsInput(q: { terms: string[]; location: string; max: number }): object`; `mapPlace(item: unknown): ImportRowIn | null` per spec 3 (drops non-US, `permanentlyClosed`, no title; website through `sanitizeUrl`, LinkedIn → dropped field; `name_key = nameKey(title)`).
- `sources-fakes.ts`: `fakeHttp(routes: Record<string, { status: number; json: unknown } | Error>): HttpJson & { calls: { method: string; url: string; headers: Record<string,string> }[] }`.

- [ ] Step 1: Tests: `mapsReserve: 50 → 0.50, 200 → 0.80, 1 → 0.50`; `mapsInput fixes the spec values and splits max across terms`; `start sends the token only in the Authorization header and passes maxTotalChargeUsd and timeout`; `status reads usageTotalUsd or null`; `mapPlace maps title, phone, website, address, zip, place_id, category`; `mapPlace drops non-US, closed, nameless; strips LinkedIn`; `apify errors never contain the token` (401, 500, network error, bad JSON).
- [ ] Step 2: FAIL → Step 3: implement → Step 4: PASS, `B + 22`.
- [ ] Step 5: Commit `feat(sources): Apify client and Google Maps place mapping`.

### Task 5: Apollo free lookup and junk filter

**Files:** Create `src/lib/sources/apollo.ts`, `tests/unit/sources-apollo.test.ts`.
**Interfaces:** `apolloClient(key: string, http: HttpJson)` → `{ checkKey(); lookup(q: { locations: string[]; naics: string[]; page: number }): Promise<unknown[]> }`; `mapOrg(item: unknown): ImportRowIn | null` (name, website = `website_url` or `https://` + domain, via `sanitizeUrl`); `isForeignDomain(host: string): boolean` (last label is 2 letters and ≠ `us`).

- [ ] Step 0 (manual, before code; Juan's key in a local shell only, never committed): one lookup call to confirm path, auth header and response keys (`organizations` / `accounts`?). Write the confirmed values into the constants; mark them confirmed in the spec table.
- [ ] Step 1: Tests: `lookup sends display_mode fuzzy_select_mode, locations, naics, page and per_page 25, key only in the header`; `lookup never calls an enrich endpoint`; `apollo junk filter drops foreign ccTLDs and domainless rows` (`acme.co.uk`, `x.com.pk`, `y.ca` dropped; `z.com`, `w.us` kept); `mapOrg strips LinkedIn and keeps no phone`.
- [ ] Step 2: FAIL → Step 3: implement → Step 4: PASS, `B + 26`.
- [ ] Step 5: Commit `feat(sources): Apollo free organization lookup with non-US filter`.

### Task 6: `runSourceTick` and the cron route

**Files:** Create `src/lib/sources/{store,tick}.ts`, `tests/unit/sources-tick.test.ts`, `tests/engine/sources-engine.test.ts`. Modify `src/app/api/hunter/tick/route.ts`, `tests/unit/hunter-route.test.ts` **(confirmar após F3b; if F3c-2 is merged, after the qualifier part)**.
**Interfaces:**
- `store.ts`: `interface SourceTickStore { beginTick(); finishTick(tickId, counts: SourceCounts, error: string | null); enqueueAgentRuns(tickId): Promise<number>; nextWork(tickId): Promise<{ start: SourceRunRow[]; poll: SourceRunRow[] }>; markStarted(tickId, runId, externalId, datasetId); markFailed(tickId, runId, error: string, costUsd: number); importRows(tickId, runId, rows: ImportRowIn[], found: number, dropped: number, costUsd: number): Promise<{ new: number; merged: number }> }`; `type SourceCounts = { started: number; polled: number; imported: number; failed: number }`; `rpcSourceStore(rpc: RpcFn)`; `createSourceTickStore(token: string)`.
- `tick.ts`: `runSourceTick(opts: { store: SourceTickStore; http?: HttpJson; now?: () => number; budgetMs?: number }): Promise<{ outcome: "ok" | "busy" | "error" } & SourceCounts>` — begin → enqueueAgentRuns → start (maps: Apify start; apollo: lookup `pages` pages, map, filter, import in the same tick, cost 0) → poll (SUCCEEDED → items(limit max) → map → import with `usageUsd ?? reserve`; FAILED/ABORTED/TIMED-OUT → markFailed with usage; RUNNING > 15 min → abort + `stale`) → finish always. Key opened with `openKey` per run, kept only in the local scope.
- Route JSON gains `sources: { outcome, started, polled, imported, failed }`; runs with or without an AI key.

- [ ] Step 1: Tests (`sources-tick.test.ts`, fake store + fake http): `busy: nothing runs`; `a queued maps run starts with its reserve as maxTotalChargeUsd`; `a run still RUNNING is left for the next tick`; `settle uses usageTotalUsd, else the reserve`; `a stale run is aborted and failed`; `apollo runs map, filter and import in one tick`; `one failing run does not stop the others; finishTick always`. `sources-engine.test.ts` (PGlite + `pgRpc`): `a succeeded run is imported exactly once across ticks` and `a Caçador run with Maps on becomes an import "Maps · {agent} · dd/mm" that hunter_known_companies includes`. `hunter-route.test.ts`: `the route runs the sources tick and reports it`.
- [ ] Step 2: FAIL → Step 3: implement → Step 4: PASS, `B + 41`.
- [ ] Step 5: Commit `feat(sources): background tick starts, polls and imports Maps and Apollo runs`.

### Task 7: "Buscar no Maps / Apollo" in LEADS and per-agent sources

**Files:** Create `src/app/(app)/leads/buscar/{page.tsx,actions.ts}`, `src/components/sources/{SearchForm,RunHistory,AgentSources}.tsx`, `src/lib/sources/view.ts`, `tests/unit/sources-view.test.ts`. Modify `src/app/(app)/leads/page.tsx` (buttons next to "Subir lista", hidden without a connection / for closer), agent page **(confirmar após F2/F3b: path)** to embed `AgentSources`, `tests/unit/routes.test.ts`.
**Interfaces:** `view.ts` (pure): `estimateLabel(kind, max): string` (`t.sources.estimate`), `runStatusLabel(row): string`, `todayLine(conn): string`. Actions `enqueueMaps(prev, form)`, `enqueueApollo(prev, form)`, `saveAgentSources(prev, form)` → zod per Global Constraints → RPC; errors `source_cap` → `capHit`, `source_not_connected` → `notConnected`. History lists the workspace's last 50 runs (status, found/dropped, cost, link to the import's history row with Desfazer); `AutoRefresh` while any run is queued/running. Terms copy shown above each form.

- [ ] Step 1: Tests: `estimate shows até US$ 0,50 for 50 places and 0,80 for 200`; `status labels for queued, running, imported, failed, refused`; `form validation: 0 or 6 terms, max 0 or 201, NAICS "23a" refused`; `routes: /leads/buscar is sender-only`.
- [ ] Step 2: FAIL → Step 3: implement → Step 4: PASS, `B + 45`; `npm run build` and `npm run lint` clean.
- [ ] Step 5: Commit `feat(sources): Buscar no Maps / Apollo in LEADS, per-agent sources, run history`.

### Task 8: P2b Apify contacts + sources in Gastos (**depende da F3c-2**)

**Files:** Create `supabase/migrations/0015_source_contacts.sql`, `src/lib/sources/contact.ts`, `tests/unit/sources-contact.test.ts`, `tests/db/sources-contact.test.ts`. Modify `src/lib/qualifier/{types,cascade}.ts`, `src/lib/sources/{store,tick}.ts`, `src/lib/spend/{view,queries}.ts`, `tests/unit/qualifier-cascade.test.ts` **(confirmar após F3c-2)**.
**Interfaces:**
- 0015: `source_run_leads (run_id → source_runs on delete cascade, lead_id → leads on delete cascade, start_url text, primary key (run_id, lead_id))`; `qualifier_request_contacts(p_tick, p_lead, p_url) returns boolean` (qualifier token path; false without an Apify connection or past cap; adds the lead to the open `queued` contact run of its workspace with < 10 leads, else a new run with reserve 0.50); `source_add_contacts(p_tick, p_run, p_rows jsonb)` (rows `{lead_id, value, url}` → `lead_fields` email, `source 'apify_contact'`, `status 'confirmed'`, `source_ref` = url; re-queues the lead per F3c-2 K-4); `source_runs.kind 'contact'` uses this instead of `source_import`.
- Cascade: new step `p2b` between `p2` and `p3`: runs only when P2 outcome ∈ `ok|site_blocked`, no non-refuted e-mail after P2, and a site is known; outcomes `queued | no_source | skipped`; never waits.
- `contact.ts` (pure): `CONTACT_ACTOR = "vdrmota~contact-info-scraper"`; `contactInput(urls: string[]): object` (spec 3 values); `keepEmails(items: unknown[], leads: { leadId: string; host: string }[]): { leadId: string; value: string; url: string }[]` per spec 3 (own domain or same-host page; placeholder/image/wixpress/sentry/domain.com dropped; LinkedIn ignored; phones ignored).
- Gastos: `source_runs` rows join the spend view as agent "Fontes", step = `Apify Maps | Apollo | Apify contatos`, lead = from `source_run_leads`; totals = `ai_calls` + `source_runs`.

- [ ] Step 1: Tests: `keepEmails keeps own-domain and same-site e-mails and drops placeholders and other sites`; `contactInput fixes maxDepth 1, sameDomain, mergeContacts, Apify proxy`; `P2b asks for contacts only when P2 found no e-mail`; `ten leads share one contact run and its 0.50 reserve`; `contact e-mails land as apify_contact with the page URL and re-queue the lead`; `Gastos shows Fontes by source and totals match ai_calls + source_runs`.
- [ ] Step 2: FAIL → Step 3: implement → Step 4: PASS.
- [ ] Step 5: Commit `feat(sources): Apify contact scraper as qualifier step P2b; sources in Gastos`.

## Manual checklist (with Juan)
- Apply 0014 (F3d-1) → deploy; 0015 only after 0012 (F3d-2).
- Juan creates/pastes in the app (not in chat): Apify API token (before the Task 7 check), Apollo API key (before Task 5 Step 0). `MAILBOX_ENC_KEY` already exists.
- Worcester MA "general contractor", 50 places: leads "Maps · …", re-run → 0 new, cost ≈ US$ 0,20-0,50 (?) on the screen and in Apify's console; cap 0.50 blocks the 2nd search; Desfazer works.
- Apollo MA + NAICS 236: no `.co.uk`/`.com.pk` leads.

## Fora da F3d
Other actors; Apollo enrich/credits; phones from the contact scraper; category filtering of Maps (perfil, F3c-4); any resale.
