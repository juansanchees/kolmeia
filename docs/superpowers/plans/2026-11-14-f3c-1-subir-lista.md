# F3c-1 Subir lista Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Juan drops a CSV or XLSX in LEADS → [Subir lista]; every valid row becomes a lead at once ("Importado · nome da lista"), with no AI, no repeats (same keys as F3a), every value kept with its source ("sem prova"), errors listed per row, and the whole import can be undone.
**Architecture:** Migration 0011 adds `lead_imports`, `lead_import_rows` and `lead_fields` (one row per value with its source: the "de onde veio" store that F3c-2 builds on). Identity of an import-only lead lives in `lead_fields` keys; a new internal `find_lead()` searches candidate keys (F3a) and field keys, and `link_lead` (F3a) is re-created on top of it, so a verified candidate joins an imported lead and an import joins a researched lead (K-1). The browser reads the file (`read-excel-file` for XLSX, F3b's `parseCsv` for CSV), detects columns, validates rows and sends batches of 500 to server actions that call sender-only RPCs; all writes and duplicate checks happen in SQL.
**Tech Stack:** Next.js 16.4.5 App Router, React 19.3, TypeScript, zod 4, Supabase/Postgres (PGlite in tests), vitest (node env, no DOM), `read-excel-file` (new, MIT).
**Spec:** `kolmeia/docs/superpowers/specs/2026-11-14-f3c-lista-qualificador-cobertura-design.md` — sections 5.1, 6, 9, 10 (row F3c-1); decisions D1, K-1, K-2, K-6, K-9, C-c, C-f, C-h. Sibling plans: `2026-11-14-f3c-2-qualificador.md` (F3c-2 + F3c-3), `2026-11-14-f3c-3-perfil-cobertura.md` (F3c-4 + F3c-5).

`APP` = `kolmeia/app`. Every command runs from `APP` unless it starts with `cd`.

## Global Constraints
- Requires F3b merged (migration 0010, `src/lib/leads/baseline.ts`, `src/lib/hunter/*`). Every F3b name used here is marked **(confirmar após F3b)**: before the task that uses it, open the merged file and adjust the call if the name or signature differs; never re-implement it.
- Baseline: Step 1 of Task 1 records `npx vitest run` as `B passed | 3 todo` (the F3b plan predicts 822). Checkpoints below are `B + n`.
- Pronto quando (spec 10, F3c-1): Juan uploads one test CSV and one test XLSX; the leads show in LEADS as "Importado · {lista}"; uploading the same list again creates 0 leads; `ai_calls` gets no row; a `=HYPERLINK(...)` cell never runs anywhere.
- Limits (K-6, values decided): 5 MB per file (`5 * 1024 * 1024` bytes), 5,000 data rows per file and per import, batches of 500 rows per server call, row text caps: name 200, every other field 300, note 1,000 characters.
- Column detection (spec 5.1, no AI): header folded (lower case, accents removed, non-alphanumerics → space, trimmed) equal to an alias. Aliases: `name` ← company, empresa, name, nome, company name, business, business name; `website` ← website, site, url, web, homepage; `phone` ← phone, tel, telefone, telephone, phone number, celular; `email` ← email, e mail, mail; `address` ← address, endereco, street; `city` ← city, cidade, town; `state` ← state, estado, st; `zip` ← zip, cep, zip code, postal code; `contact_name` ← contact, contato, contact name, owner, decision maker; `contact_title` ← title, cargo, job title, role; `note` ← notes, note, obs, observacao, observacoes, nota, comments. First column wins; a field is never mapped twice.
- Row rules: at least one of name, website, phone, email, else error `empty`. Phone valid when `phoneKey()` is not null (≥ 10 digits), else `phone`. E-mail valid when it matches `^[^\s@]+@[^\s@]+\.[^\s@]+$` and ≤ 254, else `email`. Website: add `https://` when there is no scheme, then `sanitizeUrl()`; null → `website` (this also refuses LinkedIn, IPs, `javascript:`). Any cap passed → `too_long`. A row with any error is not imported (spec: "linha com erro não entra"). No website but an e-mail whose domain is not webmail and `domainKey()` is not null → `website = "https://" + domain` (spec 5.1). `WEBMAIL_HOSTS` = gmail.com, googlemail.com, yahoo.com, ymail.com, outlook.com, hotmail.com, live.com, msn.com, aol.com, icloud.com, me.com, mac.com, proton.me, protonmail.com, comcast.net, verizon.net, att.net, gmx.com. No name → name = website host, else the e-mail, else the phone as typed; `name_key = nameKey(name)`.
- Duplicates (D1, K-1): same `name_key` OR `company_domain_key(website)` OR `company_phone_key(phone)` as a lead of the workspace, through its linked candidates (F3a) or its non-refuted `lead_fields`; priority name, domain, phone; ties → oldest lead. Same advisory lock as `link_lead` (`'lead:' || workspace_id`). Rows of one file that are the same company merge into the first one.
- Merge (K-2): never overwrite, never delete. Every distinct value is its own `lead_fields` row with `source 'import'`, `source_ref` = the import id, `status 'unverified'` ("importado, sem prova"). A research candidate is never modified by an import.
- Undo (K-9): deletes the leads this import created, unless the lead has a research candidate or values from another import (then it stays, losing only this import's values; if its origin was this import, `origin_import_id` moves to the oldest other import that has values on it). Always deletes this import's `lead_fields` and `lead_import_rows`; the import row stays with `status 'undone'`.
- Privacy (spec 6, 9): the raw file is never sent or stored; only mapped rows. Rows and fields are workspace-private (RLS); nothing of a list goes to logs, errors or the repo. Test fixtures are synthetic only (names like "Acme Test Builders", domains `*.example`, phones `508-555-01xx`).
- Roles (J2): owner/sdr only for imports; the closer sees no button, no history, no import routes, and reads `lead_fields` only of leads assigned to her.
- No AI anywhere in this plan. No change to `ai_calls`.
- XLSX library: `read-excel-file` (MIT). Before Task 3: `npm view read-excel-file version license time --json`; pin the newest version published ≥ 14 days ago (exact version, no `^`); after install `npm audit --omit=dev` must show no high/critical for it. If the license is not MIT or the audit fails: stop and ask. Never the npm `xlsx` package (stale on npm "?").
- Migration `supabase/migrations/0011_lists.sql`: re-runnable style of 0009/0010 (`if not exists`, `drop policy if exists`, revoke-then-grant, `security definer` + `set search_path = ''`). Depends on 0001-0010. Applying it is the manual checklist. Deploy order: 0011, then code.
- Next 16 differs from training data (`APP/AGENTS.md`): before Task 5 read `node_modules/next/dist/docs/` on Server Actions (body size limit, `serverActions.bodySizeLimit`; one batch of 500 rows must stay under the default) and on client components calling actions.
- Copy (Brazilian Portuguese, short; identifiers English; never "pearchat"). New `src/messages/pt/imports.ts` exported as `t.imports`. Verbatim: `button: "Subir lista"`, `steps: { file: "Arquivo", columns: "Colunas", preview: "Prévia", done: "Pronto" }`, `drop: "Arraste um CSV ou XLSX (até 5 MB, 5.000 linhas)"`, `sheet: "Aba"`, `listName: "Nome da lista"`, `training: "Usar como treino"`, `trainingHelp: "A lista também ensina o Caçador o que você procura. Nada muda sem o seu OK."`, `ignore: "(ignorar)"`, `previewCounts: "{rows} linhas · {new} novos · {merged} já existem · {errors} com erro"`, `back: "Voltar"`, `import: "Importar"`, `progress: "Importando {done} de {total}…"`, `doneCounts: "{new} leads novos · {merged} já existiam (dados somados) · {errors} com erro"`, `rowError: "linha {row}: {error}"`, `rowErrors: { empty: "sem nada para identificar", phone: "telefone inválido", email: "e-mail inválido", website: "site inválido", too_long: "texto longo demais" }`, `fileErrors: { tooBig: "Arquivo maior que 5 MB.", tooManyRows: "Mais de 5.000 linhas. Divida a lista.", unreadable: "Não consegui ler este arquivo. Use CSV ou XLSX.", noIdColumn: "Nenhuma coluna de empresa, site, telefone ou e-mail." }`, `history: "Listas subidas"`, `statuses: { importing: "incompleta", done: "importada", undone: "desfeita" }`, `undo: "Desfazer import"`, `undoConfirm: "Apagar os leads que esta lista criou? Dados de outras fontes ficam."`, `undoYes: "Sim, desfazer"`, `undoNo: "Não"`, `undoneCounts: "{deleted} leads apagados · {kept} ficaram (têm dados de outras fontes)"`, `fields: { name: "Empresa", website: "Site", phone: "Telefone", email: "E-mail", address: "Endereço", city: "Cidade", state: "Estado", zip: "ZIP", contact_name: "Contato", contact_title: "Cargo", note: "Nota" }`. In `t.leads`: `imported: "Importado · {list}"`, `unproven: "sem prova"`, `sources: { import: "importado", site: "site", places: "Places", ai: "IA", research: "pesquisa" }`, `fieldsTitle: "De onde veio"`.
- Reuse, do not fork: `nameKey`/`domainKey`/`phoneKey`/`dedupe`, `sanitizeUrl`/`hostOf`, `csvCell`/`toCsv`, `inChunks`, `parseCsv` (F3b `baseline.ts`, confirmar após F3b), `Notice`, `date`, `requireSender`, the two-step confirm pattern of F3b `ArchiveButton`.
- Git: public repo; one commit per task, message given, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `.env*`, real lists, `data/` files or real leads. No push/deploy steps. SDD ledger `kolmeia/.superpowers/sdd/f3c-1/progress.md` (local only).

## Review Focus
1. **Deleting the old search whose candidate joined an imported lead** (F3a L3 deletes a lead when its last candidate goes) silently erases the imported phones/e-mails. Expect the lead kept with `best_candidate_id` null. Owner: Task 1 (`deleting the only candidate of a lead with imported values keeps the lead`).
2. **Excel's CSV export** (`;` separator, BOM, CRLF, quoted line breaks, phone typed as number `5085550199` or shown as `5.09E+09`, empty trailing rows). Expect correct columns; a scientific-notation phone is a row error `telefone inválido`, never a wrong number; empty rows are skipped, not errors. Owner: Task 3 (`parseDelimited…`, `mapRow refuses a phone in scientific notation…`, `blank rows are skipped`).
3. **The tab is closed in the middle of a 4,000-row upload.** Expect the batches already sent to be leads, the import shown as "incompleta" in the history with Desfazer working, and a re-upload of the same file creating only the missing ones. Owners: Task 2 (`an unfinished import can be undone…`), Task 5 (`the history lists incomplete imports with undo`).
4. **Hostile cells** (`=HYPERLINK("http://x","y")` in a note, `javascript:alert(1)` as site, `<script>` in a name, a 20,000-character cell). Expect text stored as text (formula kept verbatim, never evaluated), the bad site a row error, the long cell a row error, and the LEADS CSV export prefixing `'` to the formula. Owners: Task 3 (`hostile cells…`), Task 4 (`leadsCsv neutralises a formula from an import`).
5. **The same company twice inside one file** ("Acme Test Builders" and "ACME TEST BUILDERS, Inc.", or two rows with the same phone). Expect one lead, the second row counted as merged with both phones kept. Owners: Task 2 (`rows of one batch that are the same company merge into the first`), Task 3 (`previewOutcomes marks in-file duplicates as merged`).

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/supabase/migrations/0011_lists.sql` (T1, T2) | tables, `find_lead`, re-created `link_lead`/`unlink_candidate_lead`, RLS (T1); import RPCs, undo, `hunter_known_companies` (T2) |
| `APP/tests/db/lists.test.ts` (T1, T2), `APP/tests/db/lists-seed.ts` (T2) | DB rules |
| `APP/src/lib/imports/{fields,rows,parse}.ts` (T3) | client-safe: aliases + detection, row mapping/validation, CSV/XLSX → string grid |
| `APP/tests/unit/imports.test.ts`, `APP/tests/fixtures/import-sample.xlsx` (T3) | pure rules; synthetic fixture |
| `APP/src/lib/leads/{types,queries,view}.ts`, `components/leads/{LeadsTable,FieldList}.tsx`, `leads/[id]/page.tsx`, `messages/pt/leads.ts` (T4) | import-only leads in LEADS and detail |
| `APP/src/lib/imports/store.ts`, `leads/subir/{page,actions}.ts(x)`, `components/imports/{ImportWizard,ImportHistory}.tsx`, `messages/pt/{imports,index}.ts`, `README.md` (T5) | upload screen, actions, history, undo |

---

### Task 1: Migration 0011 — lead_fields, imports tables, one duplicate rule for candidates and imports

**Files:** Create `supabase/migrations/0011_lists.sql`, `tests/db/lists.test.ts`.
**Interfaces:**
- Produces tables (RLS enabled and forced; clients get SELECT only, granted per policy below; no client INSERT/UPDATE/DELETE):
  - `lead_imports (id uuid pk, workspace_id → workspaces on delete cascade, created_by uuid → auth.users on delete set null, file_name text 1..200, sheet_name text ≤ 100 null, list_name text 1..80, mapping jsonb object ≤ 8000 bytes, use_as_training boolean not null default false, status text default 'importing' check in ('importing','done','undone'), row_count/new_count/merged_count/error_count integer not null default 0, created_at, finished_at)`.
  - `lead_import_rows (id, import_id → lead_imports on delete cascade, workspace_id, row_number integer 1..5001, data jsonb ≤ 4000 bytes, lead_id → leads on delete set null, outcome text check in ('new','merged','error'), error text ≤ 40, unique (import_id, row_number))`.
  - `lead_fields (id, workspace_id, lead_id → leads on delete cascade, field text check in ('name','phone','email','website','address','city','state','zip','contact_name','contact_title','company_type','note','active_project','place_id'), value text 1..1000, key text, source text check in ('import','site','places','ai','research'), source_ref text ≤ 2000, status text not null default 'unverified' check in ('unverified','confirmed','refuted'), excerpt text ≤ 300, seen_at timestamptz not null default now(), created_at)`; indexes `(workspace_id, field, key) where key is not null`, `(lead_id)`; unique index `lead_fields_distinct on (lead_id, field, coalesce(key, lower(btrim(value))), source, coalesce(source_ref, ''))` (K-2: same value from another list is another row).
  - Trigger `lead_field_key` BEFORE INSERT OR UPDATE OF value: `key` = `company_domain_key(value)` for website, `company_phone_key(value)` for phone, `lower(btrim(value))` for email; for `name` the writer's key is kept (TS `nameKey`, as for candidates); null otherwise.
- `leads`: `origin_kind` check adds `'import'`; `origin_import_id uuid references lead_imports on delete set null`.
- `public.find_lead(p_ws uuid, p_name_key text, p_domain text, p_phone text, p_exclude_candidate uuid) returns uuid` (internal, no grant): F3a's candidate search UNION the same match over `lead_fields` (field name/website/phone, `status <> 'refuted'`); same priority and tie rule.
- `link_lead(...)` re-created: same signature and lock; uses `find_lead`; a found lead with null `best_candidate_id` gets the candidate as best (the existing update already does it).
- `unlink_candidate_lead()` re-created: no verified candidate left AND the lead has a `lead_fields` row with `source <> 'research'` → `best_candidate_id = null`, keep; otherwise as F3a.
- `public.lead_visible_to_assignee(p_lead uuid) returns boolean` (stable, security definer; granted to authenticated). Policies: `lead_fields_select` = sender OR `lead_visible_to_assignee(lead_id)`; `lead_imports_select`, `lead_import_rows_select` = `is_workspace_sender(workspace_id)`.

- [ ] Step 1: Baseline `npx vitest run` → record `B`. Create the ledger.
- [ ] Step 2: Write `tests/db/lists.test.ts` (setup like `leads.test.ts`: two workspaces, owner A, sdr, closer D, owner B; helpers `importOnlyLead(ws, fields: {field, value, key?}[])` via admin). `describe("0011 lead fields and one duplicate rule")`:
  - `lead_fields keys follow the SQL company keys on the shared vectors` — for each of `WEBSITE_VECTORS`/`PHONE_VECTORS` (non-empty) inserted by admin as website/phone fields: `key` equals `company_domain_key`/`company_phone_key` of the value; e-mail `Info@Acme.Example` → `info@acme.example`.
  - `K-1 a verified candidate joins an import-only lead with the same name, domain or phone` — three import-only leads (name key `acme test builders`; website `https://bay.example`; phone `508-555-0101`); verifying candidates "ACME Test Builders, Inc.", "Bay Dev" (site `http://www.bay.example/x`), "Zeta" (phone `+1 508 555 0101`) → each `lead_id` = the matching lead, its `best_candidate_id` = the candidate, lead count unchanged.
  - `refuted fields identify nobody` — the same phone field with `status 'refuted'` → a new lead.
  - `deleting the only candidate of a lead with imported values keeps the lead` — import-only lead joined by a verified candidate; admin deletes the candidate's run → lead exists, `best_candidate_id` null; a research-only lead in the same test still disappears (F3a L3).
  - `clients cannot write lead_fields, lead_imports or lead_import_rows` — insert/update/delete as owner A → permission error on each.
  - `the closer reads fields only of leads assigned to her; another workspace reads nothing` — admin sets `owner_id = D` on one lead → D sees its fields only; B sees none of A's; D sees no `lead_imports`.
- [ ] Step 3: Run `npx vitest run tests/db/lists.test.ts` → FAIL (relation `lead_fields` does not exist).
- [ ] Step 4: Write the T1 part of `0011_lists.sql` per Interfaces.
- [ ] Step 5: Run the file → PASS; `npx vitest run` → `B + 6` passed | 3 todo (`leads.test.ts`, `hunter-*.test.ts` green unchanged).
- [ ] Step 6: Commit `feat(db): 0011 lead_fields with sources, import tables, one duplicate rule for candidates and imports`.

### Task 2: Migration 0011 — import, preview, finish and undo RPCs; the Caçador sees imported leads

**Files:** Modify `supabase/migrations/0011_lists.sql` (append), `tests/db/lists.test.ts`, `src/lib/research/supabase-store.ts`, `tests/engine/sql-store.ts`. Create `tests/db/lists-seed.ts`.
**Interfaces:** (all `security definer`, `set search_path = ''`, revoke from public/anon, grant execute to authenticated; each starts with `auth.uid()` not null and `is_workspace_sender` of the import's workspace, else 42501)
- Row payload `ImportRowIn` (JSON object; unknown keys → 22023): `{ row: int, name: text, name_key: text, website?, phone?, email?, address?, city?, state?, zip?, contact_name?, contact_title?, note? }` or `{ row: int, error: text, data: object }` for a row the browser refused.
- `create_lead_import(p_ws uuid, p_file_name text, p_sheet_name text, p_list_name text, p_mapping jsonb, p_use_as_training boolean) returns uuid` (`created_by = auth.uid()`).
- `preview_import_rows(p_import uuid, p_rows jsonb) returns jsonb` → `[{ row, lead_id }]` (`lead_id` null = new), read-only, ≤ 500 rows.
- `import_lead_rows(p_import uuid, p_rows jsonb) returns jsonb` → `{ new, merged, errors }`: import must be `importing` (else 22023); > 500 rows per call or `row_count` passing 5,000 → 22023; per row, under the `'lead:'` lock: error rows → `lead_import_rows` only; else `find_lead(ws, name_key, company_domain_key(website), company_phone_key(phone), null)`; none → insert `leads (origin_kind 'import', origin_import_id, best_candidate_id null)`; found → `last_seen_at = now()`; then one `lead_fields` row per non-empty value (`source 'import'`, `source_ref = p_import::text`, `status 'unverified'`, `name` with `key = name_key`) `on conflict do nothing`; then the `lead_import_rows` row (`data` = the payload without `row`). Bumps the import's counts.
- `finish_lead_import(p_import uuid) returns void` → `status 'done'`, `finished_at = now()` (only from `importing`).
- `undo_lead_import(p_import uuid) returns jsonb` → `{ deleted, kept }` per Global Constraints (from `importing` or `done`; `undone` → 22023).
- `hunter_known_companies(p_tick, p_run)` re-created **(confirmar após F3b: copy its merged body and signature)**: the same list plus leads with null `best_candidate_id` as `{ name, website, phone }` = their oldest non-refuted `name`/`website`/`phone` field values. `SupabaseResearchStore.knownCompanies` and `SqlResearchStore.knownCompanies` **(confirmar após F3b)** read the same union.
- `tests/db/lists-seed.ts`: `seedImport(db, user: string, ws: string, rows: ImportRowIn[], opts?: { listName?: string }): Promise<{ importId: string; result: { new: number; merged: number; errors: number } }>` (create + import in batches of 500 + finish, as the user); `row(n: number, name: string, extra?: Partial<ImportRowIn>): ImportRowIn` (fills `name_key` with `nameKey`).

- [ ] Step 1: Add to `tests/db/lists.test.ts` `describe("0011 import RPCs")`:
  - `import creates one lead per company and merges into existing leads (D1)` — a researched lead "Bay Dev" (site `bay.example`) exists; rows: "Acme Test Builders" (new), "Bay Developers" site `https://www.bay.example` (merged into Bay Dev), "Zeta" → `{ new 2, merged 1, errors 0 }`; new leads have `origin_kind 'import'`, `origin_import_id`; Bay Dev's candidate row is byte-for-byte unchanged.
  - `rows of one batch that are the same company merge into the first` — "Acme Test Builders" + "ACME TEST BUILDERS, Inc." (phone 508-555-0102) → 1 lead, `merged 1`, two `name` fields and one phone field on it.
  - `importing the same list again creates 0 leads`.
  - `K-2 every distinct phone and e-mail stays, each with its list; nothing is overwritten` — two imports with different phones for the same company → two phone fields with each `source_ref`; the same phone in both → two rows (one per list).
  - `error rows are stored with their code and create nothing`.
  - `limits: 501 rows in one call, more than 5,000 in one import, or rows after finish are refused (22023)`.
  - `preview says new or existing and writes nothing` — counts of `leads`, `lead_fields`, `lead_import_rows` unchanged.
  - `K-9 undo deletes only what this import created` — (a) created by A only → deleted; (b) existed before, A merged → kept, A's fields gone; (c) created by A, later joined by a verified candidate → kept; (d) created by A, then B merged → kept, `origin_import_id = B`; result `{ deleted 1, kept 3 }`; A `undone`, its rows gone; a second undo → 22023.
  - `an unfinished import can be undone and its leads are gone` — import 2 batches, no finish, undo → deleted.
  - `the closer and another workspace cannot create, preview, import, finish or undo (42501)`.
  - `no AI is used: ai_calls has no row after imports`.
  - `C4 the Caçador's known companies include import-only leads` **(confirmar após F3b)** — `seedHunter` + `beginTick` + `hunter_due_work`; an import-only "Acme Test Builders" → `hunter_known_companies` contains it with its website and phone.
- [ ] Step 2: Run the file → FAIL.
- [ ] Step 3: Append the T2 part of `0011_lists.sql`; write `lists-seed.ts`; update both `knownCompanies`.
- [ ] Step 4: Run the file → PASS; `npx vitest run` → `B + 18` | 3 todo (`hunter-engine.test.ts` C4 test green).
- [ ] Step 5: Commit `feat(db): import, preview, finish and undo of lists; Caçador skips imported companies`.

### Task 3: Reading the file, detecting columns, validating rows (pure, client-safe)

**Files:** Create `src/lib/imports/{fields,rows,parse}.ts`, `tests/unit/imports.test.ts`, `tests/fixtures/import-sample.xlsx`. Modify `package.json`/`package-lock.json` (`read-excel-file`, exact version), `src/lib/leads/baseline.ts` (`parseCsv` gains `sep`, **confirmar após F3b**).
**Interfaces:**
- `fields.ts`: `IMPORT_FIELDS = ["name","website","phone","email","address","city","state","zip","contact_name","contact_title","note"] as const`; `type ImportField`; `type Mapping = (ImportField | null)[]` (one entry per column); `foldHeader(h: string): string`; `detectMapping(headers: string[]): Mapping`; `hasIdColumn(m: Mapping): boolean` (name, website, phone or email mapped).
- `rows.ts`: `type ImportRow` = the `ImportRowIn` shape of Task 2 (values `string | null`); `type RowErrorCode = "empty" | "phone" | "email" | "website" | "too_long"`; `type RowError = { row: number; error: RowErrorCode; data: Record<string, string> }`; `WEBMAIL_HOSTS: readonly string[]`; `IMPORT_CAPS = { name: 200, field: 300, note: 1000 }`; `mapRow(cells: string[], mapping: Mapping, row: number): ImportRow | RowError | null` (null = blank row); `previewOutcomes(rows: ImportRow[], existing: Map<number, string | null>): { row: number; outcome: "new" | "merged" }[]` (merged when the database found a lead OR `dedupe` says an earlier row of the file is the same company).
- `parse.ts`: `IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 5000, batch: 500 }`; `parseDelimited(text: string): string[][]` (BOM stripped; `;` when the first line has more `;` than `,` outside quotes, else `,`; calls `parseCsv(text, sep)`); `sheetRows(raw: unknown[][]): string[][]` (null/undefined → `""`; Date → `YYYY-MM-DD`; number → `String(n)` with no exponent rewriting; boolean → `"true"/"false"`; strings trimmed); `readFileGrid(file: File, sheet?: string): Promise<{ sheets: string[]; sheet: string | null; rows: string[][] }>` (client only: `.csv`/`text/csv` → `parseDelimited(await file.text())`; `.xlsx` → dynamic `import("read-excel-file")`, sheet names, then `sheetRows`; anything else, a size over `maxBytes` or a parse error → throws `ImportFileError` with `code: "tooBig" | "unreadable"`). Header = first non-blank row; data rows > `maxRows` → `ImportFileError("tooManyRows")`.

- [ ] Step 1: Install `read-excel-file` per Global Constraints. Create the fixture with a local script that is not committed (e.g. `python3 -c` with openpyxl): sheet "Plan1" with headers `Company, Tel, Mail, City, Obs` and 4 synthetic rows (one `Obs` cell is the formula `=HYPERLINK("http://x.example","y")`, one `Tel` is the number 5085550103); sheet "Outra" with one row.
- [ ] Step 2: Write `tests/unit/imports.test.ts`:
  - `detectMapping finds English and Portuguese headers and maps a field once` — `["Empresa","Telefone","E-mail","Cidade","Obs","X","Company"]` → `[name, phone, email, city, note, null, null]`; `["Website","Contact Name","Job Title","ZIP Code"]` → `[website, contact_name, contact_title, zip]`.
  - `mapRow: site from a business e-mail, never from webmail; name falls back to host` — `{email: "info@acme.example"}` → website `https://acme.example`, name `acme.example`; `{email: "joe@gmail.com", phone: "508-555-0104"}` → website null, name `joe@gmail.com`.
  - `mapRow: errors per row` — no identifier → `empty`; phone `555-0199` → `phone`; email `a@b` → `email`; website `javascript:alert(1)` and `https://linkedin.com/company/x` → `website`; a 201-character name → `too_long`.
  - `mapRow refuses a phone in scientific notation` — `5.09E+09` → `phone`.
  - `blank rows are skipped` — all cells empty → null.
  - `hostile cells: a formula and markup stay text` — note `=HYPERLINK("http://x","y")` and name `<script>x</script>` kept verbatim.
  - `parseDelimited reads Excel's semicolon CSV with BOM, CRLF and quoted line breaks`.
  - `sheetRows turns numbers, dates, booleans and nulls into text` — `[5085550103, new Date("2026-11-14"), true, null]` → `["5085550103","2026-11-14","true",""]`.
  - `the XLSX fixture reads as text through read-excel-file` — via the library's Node entry (`read-excel-file/node` or the one its docs name for Node), sheet names `["Plan1","Outra"]`, the formula cell gives its cached value or text, never runs; rows pass through `sheetRows`.
  - `previewOutcomes marks in-file duplicates as merged` — rows "Acme Test Builders" and "ACME TEST BUILDERS, Inc." with no database match → `new`, `merged`.
- [ ] Step 3: Run `npx vitest run tests/unit/imports.test.ts` → FAIL.
- [ ] Step 4: Implement per Interfaces.
- [ ] Step 5: Run the file → PASS; `npx vitest run` → `B + 28` | 3 todo (`baseline.test.ts` green).
- [ ] Step 6: Commit `feat(imports): column detection, row validation and CSV/XLSX reading in the browser`.

### Task 4: Import-only leads in LEADS and in the lead page

**Files:** Create `src/components/leads/FieldList.tsx`. Modify `src/lib/leads/{types,queries,view}.ts`, `src/components/leads/LeadsTable.tsx`, `src/app/(app)/leads/[id]/page.tsx`, `src/messages/pt/leads.ts`, `tests/unit/{leads,leads-queries,nav}.test.ts`.
**Interfaces:**
- `types.ts`: `LeadRow.origin_kind` adds `"import"`; `LeadRow.origin_import_id: string | null` (in `LEAD_COLUMNS`); `LEAD_FIELD_NAMES`, `type LeadFieldRow = { id: string; lead_id: string; field: LeadFieldName; value: string; source: "import" | "site" | "places" | "ai" | "research"; source_ref: string | null; status: "unverified" | "confirmed" | "refuted"; excerpt: string | null; seen_at: string }`; `LEAD_FIELD_COLUMNS`; `type LeadDisplay = { name: string; city: string | null; phone: string | null; website: string | null; email: string | null }`; `LeadListItem` becomes `{ lead: LeadRow; best: CandidateRow | null; display: LeadDisplay; agentName: string | null; importName: string | null; proofOk: number }`; `LeadDetail` adds `fields: LeadFieldRow[]` and `importNames: Record<string, string>`.
- `view.ts`: `displayOf(best: CandidateRow | null, fields: LeadFieldRow[]): LeadDisplay` (best's values first; else the oldest non-refuted field of each kind); `filterLeads` keeps a lead without `best` only in tab `all` with temperature `all`, searches `display`; sort puts them after leads with a temperature; `originLabel(i)` → agent name, `fill(t.leads.imported, { list })` for `import`, else `oneOff`; `leadsCsv` uses `best` or an all-null `CandidateRow` built from `display` (`id = lead.id`) so `toCsv`/`csvCell` stay the only writers.
- `queries.ts`: `listLeads` drops the `best_candidate_id is not null` filter, reads up to `LEADS_MAX = 5000` leads in pages of 1,000 (`range`), loads display fields of leads without best (`inChunks` with `FIELD_CHUNK = 50` leads per request, fields `name, website, phone, email, city`) and import names; `getLead` also loads `fields` (all of the lead, oldest first) and the names of the imports they cite.
- `FieldList({ fields, importNames })` (server component): one line per field: label (`t.imports.fields` / `t.leads` labels), value, source label (`t.leads.sources`; import shows the list name), `date(seen_at)`, `⚠ ` + `t.leads.unproven` when `status === "unverified"`, struck-through when `refuted`; a `source_ref` URL shown as a link only if `sanitizeUrl` accepts it.
- Lead page: works when `candidates` is empty (header from `displayOf`), shows `FieldList` under the title as `t.leads.fieldsTitle`.

- [ ] Step 1: Failing tests:
  - `leads.test.ts`: `displayOf prefers the best candidate and falls back to the oldest unrefuted field`; `filterLeads keeps import-only leads only in Todos and finds them by name, city and phone`; `originLabel says Importado · list`; `leadsCsv writes import-only leads and neutralises a formula from an import` — a note field is not exported, but a name `=HYPERLINK("http://x","y")` comes out as `"'=HYPERLINK(""http://x"",""y"")"`.
  - `leads-queries.test.ts` (existing fake-client pattern): `listLeads reads leads without a best candidate with their display fields, in pages of 1000` — 1,200 fake leads → two `range` calls, items 1,200.
  - `nav.test.ts`: `the lead page renders import-only leads with their sources` — `leads/[id]/page.tsx` contains `FieldList` and no `if (!best) notFound()`.
- [ ] Step 2: Run the three files → FAIL.
- [ ] Step 3: Implement per Interfaces; `LeadsTable` shows `display.name` and the origin label.
- [ ] Step 4: Run → PASS; `npx tsc --noEmit` → 0 errors; `npx vitest run` → `B + 34` | 3 todo.
- [ ] Step 5: Commit `feat(leads): imported leads in LEADS with their sources ("sem prova")`.

### Task 5: The upload screen, actions, history and undo

**Files:** Create `src/lib/imports/store.ts`, `src/app/(app)/leads/subir/{page.tsx,actions.ts}`, `src/components/imports/{ImportWizard,ImportHistory}.tsx`, `src/messages/pt/imports.ts`. Modify `src/lib/imports/rows.ts`, `src/messages/pt/index.ts`, `src/components/leads/LeadsTable.tsx` (button), `tests/unit/{nav,imports}.test.ts`, `README.md`.
**Interfaces:**
- `rows.ts` adds `revalidateRow(r: ImportRow | RowError): ImportRow | RowError` (a `RowError` passes through with `data` capped; an `ImportRow` is rebuilt as cells in `IMPORT_FIELDS` order and run through `mapRow` with that identity mapping, keeping `row`).
- `store.ts` (`server-only`): `createImport(db: SupabaseClient, ws: string, meta: { fileName: string; sheetName: string | null; listName: string; mapping: Mapping; useAsTraining: boolean }): Promise<string>`; `previewRows(db, importId: string, rows: ImportRow[]): Promise<Map<number, string | null>>`; `importRows(db, importId, rows: (ImportRow | RowError)[]): Promise<{ new: number; merged: number; errors: number }>`; `finishImport(db, importId): Promise<void>`; `undoImport(db, importId): Promise<{ deleted: number; kept: number }>`; `listImports(db, ws): Promise<ImportListItem[]>` (`ImportListItem = { id; list_name; file_name; status; row_count; new_count; merged_count; error_count; created_at }`, newest first, 100). Database errors rethrown with their message, never row data.
- `actions.ts` (`"use server"`): `startImportAction(meta)`, `previewBatchAction(importId: string, rows: ImportRow[])`, `importBatchAction(importId: string, rows: (ImportRow | RowError)[])`, `finishImportAction(importId: string)`, `undoImportAction(importId: string)`. Each: `requireSender()`; uuid check; `rows.length <= IMPORT_LIMITS.batch`; **re-validates every row on the server** with `revalidateRow` (the server's verdict is what gets written); `revalidatePath("/leads", "layout")` after import/finish/undo. Return `{ ok: true, … } | { ok: false, error: string }` (copy from `t.imports`).
- `ImportWizard` (client): steps file → columns → preview → done exactly as spec 5.1 (sheet picker for XLSX, list name required, column selects with `t.imports.fields` + `ignore`, the training checkbox, preview table of the first 20 rows with status, counts with `previewCounts`, the error list `rowError` lines, progress `progress` while batches run, final `doneCounts`). File errors show `fileErrors`. A `noIdColumn` mapping blocks "Prévia".
- `ImportHistory({ items })` (client): list name, `date`, status from `statuses` (`importing` = "incompleta"), counts, two-step undo (`undo` → `undoConfirm` + `undoYes`/`undoNo`) on `importing`/`done`, then `undoneCounts`.
- `leads/subir/page.tsx`: `requireSender()`; `ImportWizard` + `ImportHistory`. `LeadsTable` shows `t.imports.button` linking `/leads/subir` when `canCreate` (also in the empty state).

- [ ] Step 1: Failing tests:
  - `imports.test.ts`: `server re-validation wins over what the browser sent` — `revalidateRow` turns a client "valid" row with phone `555-0199` into `RowError phone`, keeps a valid one unchanged, drops unknown keys, and recomputes `name_key` (a forged `name_key` is replaced).
  - `nav.test.ts`: `the upload screen is sender-only and batches of 500 go through server actions` — `leads/subir/page.tsx` contains `requireSender`; `actions.ts` contains `"use server"`, `requireSender` and `IMPORT_LIMITS.batch`; `LeadsTable.tsx` renders `t.imports.button` only under `canCreate`; no file under `src` reads `file.text()` or `read-excel-file` outside `src/lib/imports/parse.ts`.
  - `nav.test.ts`: `the history lists incomplete imports with undo` — `ImportHistory.tsx` contains `statuses`, `undoConfirm`.
- [ ] Step 2: Run both files → FAIL.
- [ ] Step 3: Implement per Interfaces. README (Portuguese): "Subir lista" (CSV/XLSX até 5 MB e 5.000 linhas; colunas detectadas; prévia; nada de IA; sem duplicar; "sem prova" até conferir; Desfazer); apply 0011 before the code.
- [ ] Step 4: Run → PASS. Checkpoint `npm run check` → typecheck, lint, `B + 37` | 3 todo, build, bundle check green; route list adds `/leads/subir`.
- [ ] Step 5: Commit `feat(imports): upload screen with column mapping, preview, batches, history and undo`.

---

## Manual checklist (after the plan, with Juan)
- [ ] C9 (Claude, read-only): 0010 is applied and the F3b checks passed.
- [ ] With Juan's OK: apply `0011_lists.sql`; deploy.
- [ ] Juan uploads a small test CSV (Excel export with `;`) and a test XLSX (two sheets) made from public company names, not a client list: rows appear in LEADS as "Importado · {lista}" with "sem prova"; `select count(*) from public.ai_calls where created_at > now() - interval '10 minutes'` → 0.
- [ ] Juan uploads the same CSV again → "0 leads novos".
- [ ] A cell `=HYPERLINK("http://example.com","x")`: shown as plain text in the lead page; the LEADS CSV opened in Excel shows the text, no link runs.
- [ ] Desfazer on the second upload → nothing deleted (it created nothing); on the first → its leads gone.

## Fora da F3c-1
- Qualificador, nível, "de onde veio" with proof from site/Places/IA → `2026-11-14-f3c-2-qualificador.md`. The step ④ link "Qualificador já começou ▸" is added there.
- Perfil aprendido ("Usar como treino" is only stored here) and Cobertura → `2026-11-14-f3c-3-perfil-cobertura.md`.
- Google Sheets / CRM links (spec 2.2), keeping the raw file, editing a lead's fields by hand.
