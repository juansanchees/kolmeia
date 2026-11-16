# Leads Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework /leads so Juan sees type, stage, contact, origin list and last touch at a glance, can archive/unarchive and set a lead's type, filter by origin list, and the page stops freezing up to 5k leads.

**Architecture:** Approach A of the spec: the page still loads every lead server-side, but hands the client a slim row (`LeadTableRow`) with the effective segment and origin lists precomputed. Classification (segment, stage, archive) lives in one pure module. Archive and segment are two new `leads` columns written only through two SECURITY DEFINER RPCs (the `leads` table is read-only for clients since 0009). The table filters, sorts and counts in memoized, single-pass functions in `lib/leads/view.ts`.

**Tech Stack:** Next.js 16 App Router (server components + server actions), React 19, Supabase (Postgres, RLS, PostgREST), zod 4, vitest 4 (unit tests in node env, DB tests in PGlite over the real migrations), Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-11-16-leads-redesign-design.md`

All paths below are relative to `app/` unless they start with `docs/`. Run every command from `app/`.

## Global Constraints

- UI copy in Portuguese (pt-BR), in `src/messages/pt/leads.ts` only (no inline literals in components); identifiers, code and comments in English.
- No literal "LinkedIn" anywhere under `app/src`.
- Never set or reference `SCHEDULER_REAL_SEND`.
- No new dependencies (package.json and package-lock.json unchanged).
- The repo is public: test fixtures use fictional data only (`*.example`, `508-555-01xx`, made-up company names). No secrets, no real leads.
- Other /leads tabs stay untouched: Com a closer (`closer/`), Ligar (`ligar/`), Tarefas, Listas, Funil, Cobertura, and every other caller of `listLeads`.
- Page size default stays 15 (`DEFAULT_PAGE_SIZE` in `src/lib/paging.ts`, existing `Pager`/`usePaged`).
- No task touches any real database (dev or prod) or deploys. Tasks only write `supabase/migrations/0030_leads_archive_segment.sql`; PGlite tests in `tests/db/` are local and allowed. The controller backs up prod, applies 0030, and only then deploys: after this branch, `LEAD_COLUMNS` selects `archived_at, segment`, so every `listLeads`/`getLead` call fails until 0030 is applied.
- Archive never deletes or alters lead data, fields, status, history or list membership: it only sets/clears `leads.archived_at`.
- Every hidden set of leads has a tab or an active-filter chip with ×.
- Segment keywords and thresholds, verbatim from the spec: Grande = company_type in (developer, property_manager), or biggest permit ≥ US$ 500k, or approach = supplier_signup, or origin list name matches administradoras / incorporadoras / comercial / BERDO. Residencial = origin list name matches residencial / empreiteiros, or permits residential and < US$ 500k. Pequena = manual only. Sem tipo = everything else. Effective = manual override ?? derived.
- Stage, verbatim: Novo = status new and no first_contacted_at. Contatado = call_list, in_campaign, or new with first_contacted_at. Respondeu = replied. Reunião = with_closer, meeting. Fechado = won, lost, discarded. Arquivados = archived_at not null (overrides the above).
- Search debounce: 200 ms.
- Verification commands: `npm run typecheck`, `npm run lint`, `npm test` (vitest, includes `tests/db`). A task is done only when all three pass.

## Review Focus

1. A saved view, the NL search ("contatados", "construtoras") or an old default view sets a filter the new screen no longer shows (`contact`, `tab`, `status`, `minLevel`, `companyTypes`, `minPermitUsd`, `origins`): the person expects a chip with × for it, never silently fewer leads. Test: Task 1 `activeFilterKeys` test.
2. List names typed with accents and mixed case ("Construção COMERCIAL", "Administradoras Boston", "EMPREITEIROS") must still map to a type. Test: Task 1 segment tests.
3. A manual type that contradicts the derived one (override "residential" on a developer) wins, and clearing it (null) falls back to the derived type. Test: Task 1 segment tests + Task 1 DB test (null clears).
4. Archive then unarchive returns the lead to the same stage, list membership and fields it had. Test: Task 1 DB test + Task 1 stage tests.
5. An import-only lead with no visible lists (the closer: RLS gives her no `lists`/`lead_imports` rows) shows "Sem tipo", an Origem from `originLabel`, and "Sem lista de origem" in the modal, never a crash or blank. Test: Task 2 `toTableRow` test + Task 4 source test.

---

### Task 1: Classification logic, filters, copy and migration 0030

**Files:**
- Create: `src/lib/leads/classify.ts`
- Create: `supabase/migrations/0030_leads_archive_segment.sql`
- Modify: `src/lib/leads/types.ts` (LeadRow, LEAD_COLUMNS, new types)
- Modify: `src/lib/leads/view.ts` (filters, facets, chips; generic row type)
- Modify: `src/lib/research/sheet.ts:57,75` (narrow `inTab`/`byTemperature` parameter types only, no behavior change)
- Modify: `src/lib/leads/shortcuts.ts:6` (import `BIG_PERMIT_USD` from `./classify` and re-export it)
- Modify: `src/messages/pt/leads.ts` (all new copy for Tasks 2-4)
- Modify: `tests/unit/leads.test.ts:22,38` (add `archived_at: null, segment: null` to the two `LeadRow` literals; any other literal `tsc` flags)
- Test: `tests/unit/leads-redesign.test.ts`, `tests/db/leads-archive-segment.test.ts`

**Interfaces:**
- Produces (in `src/lib/leads/types.ts`):
  - `SEGMENTS = ["residential", "small", "large"] as const`, `type Segment`
  - `LEAD_STAGES = ["new", "contacted", "replied", "meeting", "closed", "archived"] as const`, `type LeadStage` (not `STAGES`: `src/lib/research/types.ts` already exports that name)
  - `LeadRow` gains `archived_at: string | null; segment: Segment | null`; `LEAD_COLUMNS` gains `, archived_at, segment`
  - `type OriginList = { name: string; at: string; kind: "import" | "list" }` (`at` = ISO date the lead entered it)
  - `TABLE_BEST_COLUMNS` (const tuple) = `id, name, temperature, approach, company_type, total_value_usd, biggest_job_value_usd, biggest_job_type, biggest_job_address, permit_count, entry_path, second_pass`; `type TableBest = Pick<CandidateRow, (typeof TABLE_BEST_COLUMNS)[number]>`
  - `type TableLead = Pick<LeadRow, "id" | "status" | "level" | "origin_kind" | "origin_agent_id" | "first_contacted_at" | "last_touch_at" | "archived_at" | "segment">`
  - `type LeadTableRow = { lead: TableLead; best: TableBest | null; display: LeadDisplay; agentName: string | null; importName: string | null; emailQuality?: EmailQuality | null; ai?: Record<string, AiCell>; origins: OriginList[]; segment: Segment | null /* effective */ }`
- Produces (in `src/lib/leads/classify.ts`, client-safe, no imports from `view.ts`):
  - `BIG_PERMIT_USD = 500_000`
  - `LIST_SEGMENT_KEYWORDS: Record<"large" | "residential", readonly string[]>` = `{ large: ["administradora", "incorporadora", "comercial", "berdo"], residential: ["residencial", "empreiteiro"] }` (matched as substrings of the folded name, so plurals match)
  - `type SegmentInput = { override: Segment | null; companyType: string | null; biggestPermitUsd: number | null; approach: string | null; biggestJobType: string | null; listNames: string[] }`
  - `derivedSegmentOf(i: Omit<SegmentInput, "override">): Segment | null`
  - `segmentOf(i: SegmentInput): Segment | null` (= `i.override ?? derivedSegmentOf(i)`)
  - `segmentInputOf(lead: Pick<LeadRow, "segment">, best: Pick<CandidateRow, "company_type" | "biggest_job_value_usd" | "approach" | "biggest_job_type"> | null, companyType: string | null, origins: OriginList[]): SegmentInput`
  - `stageOf(lead: Pick<LeadRow, "status" | "first_contacted_at"> & { archived_at?: string | null }): LeadStage`
- Produces (in `src/lib/leads/view.ts`):
  - `type SegmentTab = Segment | "none"`
  - `FacetFilters` gains `lists: string[]`; `LeadFilters` gains `segment: SegmentTab | "all"`, `stage: LeadStage | "all"`; `temperature` becomes `Temperature | "all" | "none"`. Defaults: `segment: "all"`, `stage: "all"`, `lists: []`. `stage: "all"` = every NON-archived lead.
  - `type FilterRow = { lead: TableLead; best: TableBest | null; display: LeadDisplay; emailQuality?: EmailQuality | null; ai?: Record<string, AiCell>; origins?: OriginList[]; segment?: Segment | null }` (both `LeadListItem` and `LeadTableRow` satisfy it; absent `origins`/`segment` = none)
  - `filterLeads<T extends FilterRow>(items: T[], f: LeadFilters): T[]`, `matchesFacets(i: FilterRow, f)`, `leadInTab(i: Pick<FilterRow, "best">, tab)`, `leadFacetsOf<T extends FilterRow>(items: T[], f): LeadFacets`
  - `LeadFacets` gains `stages: Record<LeadStage, number>`, `segments: Record<SegmentTab | "all", number>`, `lists: FacetCount<string>[]` (existing `tabs`, `origins` etc. stay)
  - `activeFilterKeys(f: LeadFilters): (keyof LeadFilters)[]` — every key whose value differs from `DEFAULT_LEAD_FILTERS` (deep compare for arrays), excluding `q`, `segment`, `stage`, `aiQuestion` (shown by the search box, the tabs and the AI column)
- Produces (copy in `src/messages/pt/leads.ts`, values below are the copy):
  - `segments: { label: "Tipo", residential: "Residencial", small: "Pequena", large: "Grande", none: "Sem tipo", all: "Todos" }`
  - `stages: { label: "Etapa", new: "Novo", contacted: "Contatado", replied: "Respondeu", meeting: "Reunião", closed: "Fechado", archived: "Arquivados" }`
  - `archive: { archive: "Arquivar", unarchive: "Desarquivar", confirm: "Arquivar? O lead sai de todas as abas e fica só em Arquivados. Nada é apagado.", archived: "{n} lead(s) arquivado(s).", unarchived: "{n} lead(s) desarquivado(s).", failed: "Não deu para arquivar. Tente de novo.", archivedOn: "Arquivado em {date}", tooMany: "No máximo 5000 leads por vez." }`
  - `segmentPick: { label: "Tipo", auto: "Automático ({value})", autoNone: "Automático (sem tipo)", bulk: "Marcar tipo", saved: "Tipo salvo em {n} lead(s).", failed: "Não deu para salvar o tipo." }`
  - `origin: { cameFrom: "Veio de:", item: "{name} ({date})", none: "Sem lista de origem", filter: "Lista de origem" }`
  - `toolbar: { filters: "Filtros", more: "Mais ações", clear: "Limpar", removeChip: "Remover filtro: {label}", aiSearch: "Busca com IA", aiQuestion: "Pergunta da IA", views: "Visões salvas", qualifier: "Qualificador", selected: "{n} selecionado(s)", noResearch: "Sem pesquisa", csvFailed: "Não deu para gerar o CSV." }`
  - `contactIcons: { email: "Tem e-mail", noEmail: "Sem e-mail", phone: "Tem telefone", noPhone: "Sem telefone" }`
  - `chips: { contact, cities, levels, hasPhone, hasEmail, origins, emailQuality, lists, temperature, agent, status, tab, minLevel, companyTypes, minPermitUsd, aiAnswer }` with pt labels (e.g. `contact: "Contato"`, `tab: "Aba da pesquisa"`, `minPermitUsd: "Alvará mínimo"`, `aiAnswer: "Resposta da IA"`; reuse wording of existing `facets`/`filters` keys)
  - `research: { title: "Pesquisa", temperature: "Temperatura", approach: "Abordagem", proof: "Prova", none: "Sem pesquisa" }`
  - `columns` gains `type: "Tipo", contact: "Contato", stage: "Etapa", origin: "Origem", lastContact: "Último contato"` (existing keys stay)

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/leads-redesign.test.ts`

```ts
const base = { override: null, companyType: null, biggestPermitUsd: null, approach: null, biggestJobType: null, listNames: [] };
test("segmentOf: Grande rules", () => {
  expect(segmentOf({ ...base, companyType: "developer" })).toBe("large");
  expect(segmentOf({ ...base, companyType: "property_manager" })).toBe("large");
  expect(segmentOf({ ...base, companyType: "builder", biggestPermitUsd: 500_000 })).toBe("large");
  expect(segmentOf({ ...base, companyType: "builder", biggestPermitUsd: 499_999 })).toBeNull();
  expect(segmentOf({ ...base, approach: "supplier_signup" })).toBe("large");
  for (const n of ["Administradoras Boston", "INCORPORADORAS 2026", "Construção COMERCIAL", "BERDO lista"])
    expect(segmentOf({ ...base, listNames: [n] })).toBe("large");
});
test("segmentOf: Residencial rules, Grande wins a conflict", () => {
  expect(segmentOf({ ...base, listNames: ["Residencial Worcester"] })).toBe("residential");
  expect(segmentOf({ ...base, listNames: ["EMPREITEIROS MA"] })).toBe("residential");
  expect(segmentOf({ ...base, biggestJobType: "Single-family residential", biggestPermitUsd: 120_000 })).toBe("residential");
  expect(segmentOf({ ...base, biggestJobType: "Single-family residential", biggestPermitUsd: 600_000 })).toBe("large");
  expect(segmentOf({ ...base, companyType: "developer", listNames: ["Residencial"] })).toBe("large");
  expect(segmentOf(base)).toBeNull(); // Sem tipo; "small" is never derived
});
test("segmentOf: manual override wins, null falls back to derived", () => {
  expect(segmentOf({ ...base, companyType: "developer", override: "residential" })).toBe("residential");
  expect(segmentOf({ ...base, override: "small" })).toBe("small");
  expect(segmentOf({ ...base, companyType: "developer", override: null })).toBe("large");
});
test("stageOf follows the spec table; archived overrides", () => {
  const s = (status, first = null, archived_at = null) => stageOf({ status, first_contacted_at: first, archived_at });
  expect(s("new")).toBe("new");
  expect(s("new", "2026-11-01T00:00:00Z")).toBe("contacted");
  expect(s("call_list")).toBe("contacted"); expect(s("in_campaign")).toBe("contacted");
  expect(s("replied")).toBe("replied");
  expect(s("with_closer")).toBe("meeting"); expect(s("meeting")).toBe("meeting");
  for (const x of ["won", "lost", "discarded"]) expect(s(x)).toBe("closed");
  expect(s("won", null, "2026-11-10T00:00:00Z")).toBe("archived");
  expect(s("new", null, "2026-11-10T00:00:00Z")).toBe("archived");
});
test("filterLeads: archived only in stage 'archived'; stage 'all' hides archived", () => { /* rows a(new), b(replied), c(archived) */
  expect(names({ stage: "all" })).toEqual(["a", "b"]);
  expect(names({ stage: "archived" })).toEqual(["c"]);
  expect(names({ stage: "replied" })).toEqual(["b"]);
});
test("filterLeads: segment tabs, 'none' = no type; lists filter matches any origin; temperature 'none' = no research", () => { ... });
test("leadFacetsOf: stage counts sum to every lead (incl. archived); segment counts sum to segments.all", () => {
  // 7 fixture rows spanning every stage and segment, f = DEFAULT_LEAD_FILTERS
  expect(Object.values(facets.stages).reduce((a, b) => a + b, 0)).toBe(7);
  expect(facets.segments.none + facets.segments.residential + facets.segments.small + facets.segments.large).toBe(facets.segments.all);
  for (const st of LEAD_STAGES) expect(facets.stages[st]).toBe(filterLeads(rows, { ...DEFAULT_LEAD_FILTERS, stage: st }).length);
});
test("activeFilterKeys: legacy hidden filters always surface as chips", () => {
  expect(activeFilterKeys(DEFAULT_LEAD_FILTERS)).toEqual([]);
  const f = parseLeadFilters({ contact: "new", tab: "signal", minPermitUsd: 500_000, companyTypes: ["builder"], q: "acme", stage: "new", segment: "large" });
  expect(new Set(activeFilterKeys(f))).toEqual(new Set(["contact", "tab", "minPermitUsd", "companyTypes"]));
});
test("parseLeadFilters keeps stage, segment, lists and temperature 'none'", () => { ... });
```

- [ ] **Step 2: Write the failing DB test** in `tests/db/leads-archive-segment.test.ts` (copy the `seedTeam`/`lead` setup style of `tests/db/leads-phase1.test.ts`; fictional names)

```ts
test("sdr archives: only archived_at changes; status, level, fields and list membership stay", async () => {
  // lead L with status 'replied', in a list; sdr calls set_leads_archived(ws, [L], true)
  expect(n).toBe(1); // returned count
  expect(row.archived_at).not.toBeNull(); expect(row.status).toBe("replied"); // level, lead_fields count, list_leads row unchanged
  expect(await call(sdr, [L], true)).toBe(0); // already archived: archived_at unchanged
  expect(await call(sdr, [L], false)).toBe(1); // unarchive -> archived_at null, status still 'replied'
});
test("closer and anon cannot archive or set segment (42501)", ...);
test("another workspace's ids are ignored (returns 0)", ...);
test("set_leads_segment: 'large' sets, null clears, 'huge' fails 22023", ...);
test("more than 5000 ids fail 22023", ...);
test("clients still cannot update leads directly", async () => {
  await expect(db.query(as(sdr), "update public.leads set archived_at = now() where id = $1", [L])).rejects.toThrow(/permission denied/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/leads-redesign.test.ts tests/db/leads-archive-segment.test.ts`
Expected: FAIL (`segmentOf` not exported; `set_leads_archived` does not exist).

- [ ] **Step 4: Write `supabase/migrations/0030_leads_archive_segment.sql`**

Header comment in the 0027-0029 style (what, why, "Depends on 0001-0029. Re-runnable."). Contents:
- `alter table public.leads add column if not exists archived_at timestamptz, add column if not exists segment text;` then `drop constraint if exists leads_segment` + `add constraint leads_segment check (segment is null or segment in ('residential','small','large'))`.
- `create index if not exists leads_archived_idx on public.leads (workspace_id) where archived_at is not null;`
- `public.set_leads_archived(p_ws uuid, p_leads uuid[], p_archived boolean) returns integer` and `public.set_leads_segment(p_ws uuid, p_leads uuid[], p_segment text) returns integer`: `language plpgsql security definer set search_path = ''`; raise `42501` unless `auth.uid() is not null and public.is_workspace_sender(p_ws)`; raise `22023` when `coalesce(cardinality(p_leads), 0) > 5000`, or when `p_segment` is not null and not in the three values; update only `where workspace_id = p_ws and id = any(p_leads)` and only rows that actually change (`archived_at is null` when archiving, `is not null` when unarchiving, `segment is distinct from p_segment`); archiving sets `archived_at = now()`, unarchiving sets `null`; also `updated_at = now()` as `set_lead_status` (0020) does; return the row count (`get diagnostics`).
- `revoke all on function ... from public, anon; grant execute on function ... to authenticated;` for both. No grant on the table (stays select-only). RLS policies unchanged.

- [ ] **Step 5: Implement types, `classify.ts`, `view.ts` changes, `sheet.ts` narrowing, shortcuts re-export and copy** per the Interfaces block.
  - Fold list names and job types with `fold()` semantics (lower case, accents removed); `classify.ts` must not import `view.ts` (avoid a cycle with `shortcuts.ts`), so copy the one-line fold or move `fold` into `classify.ts` and re-export it from `view.ts`.
  - "Permits residential" has no per-permit data in the schema: use `biggestJobType` matching `/resid|single[- ]?family|two[- ]?family|house|home/` (folded) and `biggestPermitUsd !== null && biggestPermitUsd < BIG_PERMIT_USD`. Comment it as `shortcut: only the biggest job's type is stored, upgrade when per-permit types exist`.
  - Rule order: override → large rules → residential rules → null.
  - In `view.ts`, stage and segment act like tabs: `filterLeads` applies them; `leadFacetsOf` computes `stages` over rows passing every filter except stage (segment applied) and `segments` over rows passing every filter except segment (stage applied) in ONE loop over the rows that pass all other filters; facets (cities, levels, lists...) apply stage and segment. Row segment = `i.segment ?? null`, origins = `i.origins ?? []`.
  - `filtersSchema` gains `segment: z.enum([...SEGMENTS, "none", "all"])`, `stage: z.enum([...LEAD_STAGES, "all"])`, `lists: z.array(z.string().max(120)).max(50)`.

- [ ] **Step 6: Run the new tests and the whole suite**

Run: `npx vitest run tests/unit/leads-redesign.test.ts tests/db/leads-archive-segment.test.ts && npm run typecheck && npm run lint && npm test`
Expected: all PASS (existing `leads.test.ts`, `leads-phase1.test.ts`, `ai-questions.test.ts`, `email-quality.test.ts`, `copilot-shortcuts.test.ts` unchanged in behavior).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0030_leads_archive_segment.sql src/lib/leads src/lib/research/sheet.ts src/messages/pt/leads.ts tests/unit tests/db/leads-archive-segment.test.ts
git commit -m "feat(leads): segment/stage/archive logic, filters and migration 0030"
```

---

### Task 2: Server data, slim rows and actions

**Files:**
- Create: `src/lib/leads/table.ts`
- Modify: `src/lib/leads/queries.ts` (add `originListsOf`; `listLeads` unchanged)
- Modify: `src/app/(app)/leads/lead-actions.ts` (append actions after `addToCallListAction`)
- Modify: `src/app/(app)/leads/page.tsx` (slim rows, initial stage)
- Modify: `src/components/leads/LeadsTable.tsx` (only: `items` prop type → `LeadTableRow[]`, Prova cell removed, CSV through `leadsCsvAction`; nothing else)
- Test: `tests/unit/leads-table-row.test.ts`

**Interfaces:**
- Consumes: Task 1 `LeadTableRow`, `TableBest`, `TABLE_BEST_COLUMNS`, `OriginList`, `Segment`, `segmentOf`, `segmentInputOf`, `LEAD_STAGES`, copy keys `archive.*`, `segmentPick.*`, `toolbar.csvFailed`.
- Produces:
  - `originListsOf(db: SupabaseClient, leadIds: string[]): Promise<Map<string, OriginList[]>>` in `src/lib/leads/queries.ts`. Sources: `lead_import_rows (lead_id, import_id)` where `outcome in ('new','merged')` → `lead_imports (id, list_name, created_at, status)` skipping `status = 'undone'` (`kind: "import"`, `at = created_at`); and `list_leads (lead_id, list_id, added_at)` → `lists (id, name)` (`kind: "list"`, `at = added_at`). Use `inLeadChunks` for lead ids and `inChunks` for the import/list ids. Each lead's array is deduped by name (earliest kept) and sorted by `at` ascending. RLS: a closer gets empty arrays.
  - `toTableRow(i: LeadListItem, origins: OriginList[]): LeadTableRow` in `src/lib/leads/table.ts` (client-safe, pure): copies only `TableLead` keys of `lead`, only `TABLE_BEST_COLUMNS` of `best`, `display`, `agentName`, `importName`, `emailQuality`, `ai`, `origins`; `segment = segmentOf(segmentInputOf(i.lead, i.best, i.display.companyType ?? null, origins))`.
  - `originText(r: Pick<LeadTableRow, "origins" | "lead" | "agentName" | "importName">): string` in `table.ts` = first origin's name, else `originLabel(r)`.
  - Server actions in `lead-actions.ts` (all `requireSender()`, ids validated with `z.array(z.string().uuid()).min(1).max(5000)`, `revalidatePath("/leads", "layout")` on success):
    - `archiveLeadsAction(leadIds: string[]): Promise<FormState>` → `rpc("set_leads_archived", { p_ws, p_leads, p_archived: true })`, success message `fill(t.leads.archive.archived, { n })`
    - `unarchiveLeadsAction(leadIds: string[]): Promise<FormState>` → same RPC with `false`, message `archive.unarchived`
    - `setLeadSegmentAction(leadIds: string[], segment: Segment | null): Promise<FormState>` → `rpc("set_leads_segment", ...)`, segment validated with `z.enum(SEGMENTS).nullable()`, message `segmentPick.saved`
    - `leadsCsvAction(leadIds: string[]): Promise<{ csv: string } | { error: string }>` → `listLeads(db, ws.id, { ids })` then `leadsCsv(items)` (the full CSV the client can no longer build from slim rows)
    - Over 5000 ids → `fail(t.leads.archive.tooMany)` (CSV: `{ error: toolbar.csvFailed }`).
  - `page.tsx`: after attaching AI answers, `const origins = sender ? await originListsOf(supabase, items.map((i) => i.lead.id)) : new Map()`; pass `items={items.map((i) => toTableRow(i, origins.get(i.lead.id) ?? []))}`. Initial filters: saved default view, else `{ ...DEFAULT_LEAD_FILTERS, stage: sender ? "new" : "all" }` (replaces the old `contact` default; `contact` stays `"all"`).

- [ ] **Step 1: Write the failing tests** in `tests/unit/leads-table-row.test.ts`

```ts
test("toTableRow keeps only what the table uses", () => {
  const r = toTableRow(fullItem /* LeadListItem with full CandidateRow incl. hook, notes, closer_brief on lead */, []);
  expect(Object.keys(r.best!).sort()).toEqual([...TABLE_BEST_COLUMNS].sort());
  expect(Object.keys(r.lead).sort()).toEqual(["archived_at", "first_contacted_at", "id", "last_touch_at", "level", "origin_agent_id", "origin_kind", "segment", "status"]);
  expect(JSON.stringify(r)).not.toContain("closer_brief");
});
test("toTableRow: effective segment from origins and override", () => {
  expect(toTableRow(importOnly, [{ name: "Administradoras Boston", at: "2026-11-01T00:00:00Z", kind: "list" }]).segment).toBe("large");
  expect(toTableRow({ ...importOnly, lead: { ...importOnly.lead, segment: "small" } }, []).segment).toBe("small");
});
test("import-only lead with no visible lists: Sem tipo and originLabel fallback", () => {
  const r = toTableRow(importOnly, []);
  expect(r.segment).toBeNull();
  expect(originText(r)).toBe(originLabel(importOnly));
});
test("originListsOf merges imports and lists, skips undone imports, sorts by date, dedupes by name", async () => {
  // fake db in the style of tests/unit/leads-queries.test.ts: lead_import_rows, lead_imports (one 'undone'), list_leads, lists
  expect(map.get("l1")).toEqual([
    { name: "Planilha Out", at: "2026-10-01T00:00:00Z", kind: "import" },
    { name: "Administradoras", at: "2026-11-02T00:00:00Z", kind: "list" },
  ]);
  expect(map.get("l2") ?? []).toEqual([]);
});
test("archive/segment/csv actions are sender-only, capped at 5000 and call the RPCs", () => {
  const code = read("src/app/(app)/leads/lead-actions.ts");
  for (const fn of ["archiveLeadsAction", "unarchiveLeadsAction", "setLeadSegmentAction", "leadsCsvAction"]) {
    const body = code.slice(code.indexOf(`export async function ${fn}`));
    expect(body.slice(0, 1200)).toContain("requireSender");
  }
  expect(code).toContain('"set_leads_archived"'); expect(code).toContain('"set_leads_segment"');
  expect(code).toMatch(/\.max\(5000\)/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/leads-table-row.test.ts`
Expected: FAIL (`toTableRow` not found).

- [ ] **Step 3: Implement `originListsOf`, `table.ts`, the four actions, the `page.tsx` wiring, and the minimal `LeadsTable` adaptation** (prop type; drop the Prova cell, since `proofOk` is not in slim rows and Task 3 removes that column anyway; `download` calls `leadsCsvAction(filtered.map((i) => i.lead.id))` and builds the Blob from `csv`, showing `toolbar.csvFailed` on error). Keep the existing `handOffLeadAction`/`setLeadStatusAction`/`addToCallListAction` order (the handoff test slices between them).

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run tests/unit/leads-table-row.test.ts && npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads/table.ts src/lib/leads/queries.ts "src/app/(app)/leads/lead-actions.ts" "src/app/(app)/leads/page.tsx" src/components/leads/LeadsTable.tsx tests/unit/leads-table-row.test.ts
git commit -m "feat(leads): slim table rows, origin lists, archive/segment/csv actions"
```

---

Tasks 3 and 4 run in parallel after Task 2: they share no files. Neither edits `src/messages/pt/leads.ts`, `lead-actions.ts`, `view.ts` or `classify.ts`; if a copy key is missing, report it instead of adding it.

### Task 3: Leads list UI rework

**Files:**
- Modify: `src/components/leads/LeadsTable.tsx` (rewrite of the toolbar/table body)
- Modify: `src/components/leads/FacetPanel.tsx` (becomes the content of the "Filtros ▾" panel)
- Create: `src/components/leads/SelectionBar.tsx`
- Test: `tests/unit/leads-table-ui.test.ts`

**Interfaces:**
- Consumes: Task 1 `LeadFilters`, `SegmentTab`, `LEAD_STAGES`, `SEGMENTS`, `filterLeads`, `leadFacetsOf` (`stages`, `segments`, `lists`), `activeFilterKeys`, `DEFAULT_LEAD_FILTERS`, copy `segments`, `stages`, `toolbar`, `chips`, `contactIcons`, `columns.*`, `origin.filter`; Task 2 `LeadTableRow`, `originText`, `archiveLeadsAction`, `unarchiveLeadsAction`, `setLeadSegmentAction`, `leadsCsvAction`.
- Produces: `SelectionBar({ selected, lists, archivedTab, onOpenQualifier, onDone }: { selected: string[]; lists: { id: string; name: string }[]; archivedTab: boolean; onOpenQualifier: () => void; onDone: () => void })`. `FacetPanel` props become `{ facets: LeadFacets; f: LeadFilters; set: (patch: Partial<LeadFilters>) => void; agents: [string, string][]; hasOneOff: boolean }`.

Layout, top to bottom (spec "Layout"):
1. Type tabs from `["residential", "small", "large", "none", "all"]` with `facets.segments[x]`, `aria-pressed`, `set({ segment: x })`.
2. Stage tabs from `LEAD_STAGES` (Arquivados visually separated) with `facets.stages[x]`, `set({ stage: x })`.
3. One row: search input (local state, pushes `set({ q })` after 200 ms via `setTimeout` in `useEffect`, cleared on unmount) · `Filtros ▾` button toggling the `FacetPanel` · `⋯` button (`aria-haspopup="menu"`, `aria-expanded`) for senders only. Menu items: Subir lista (`/leads/subir`), Buscar no Maps / Apollo (only when `sources.maps` / `sources.apollo`), Baixar CSV, Busca com IA (`NlSearch`), Pergunta da IA (`AiQuestionPanel`), Visões salvas (`ViewBar`), Qualificador (`QualifyControls` with `filteredIds` and `selected`). The four panels render one at a time below the row (`openPanel: "nl" | "ai" | "views" | "qualify" | null`).
4. Chips: one per `activeFilterKeys(f)` → `chips[key]` + value text + × button (`aria-label` from `toolbar.removeChip`) that sets that key back to `DEFAULT_LEAD_FILTERS[key]`; "Limpar" resets all of them (keeps `q`, `segment`, `stage`, `aiQuestion`). `?lista=` banner stays.
5. Table, columns: Empresa (+ cidade, EmailBadge) · Tipo (`segments[r.segment ?? "none"]`) · Contato (✉ ☎, filled/empty, `sr-only` text from `contactIcons`) · Etapa (`stages[stageOf(r.lead)]`) · Origem (`originText(r)`, truncated, full list in `title`) · Último contato (`lastTouch(r.lead.last_touch_at)`) · optional AI column. Remove Nível, Temp., Abordagem, Status, Prova, Agente columns. Rows keep `leadHref` + `scroll={false}` + `openedFromList.value = true`; `usePaged(filtered, JSON.stringify(f))` + `Pager` + select-page checkbox stay.
6. `SelectionBar` only when `selected.length > 0`: `{n} selecionado(s)` · `AddToList` · `EmailTools` (Achar e-mail · Checar e-mails) · Qualificar (calls `onOpenQualifier`) · Marcar tipo (select of `SEGMENTS` + "Sem tipo" = null → `setLeadSegmentAction`) · Arquivar (or Desarquivar when the Arquivados tab is open) via `ActionButton` with `archive.confirm` on Arquivar. `onDone` clears selection and `router.refresh()`.

Removed from the main screen: shortcut buttons (`SHORTCUTS` import gone), the Temperatura/Agente/Status/Nível select row, research `TABS`, `CONTACT_TABS`. `FacetPanel` groups: Cidade, Lista de origem (`facets.lists`, toggles `f.lists`), Tem e-mail, Tem telefone, Qualidade do e-mail, Nível (`levels`), Temperatura (select: Todos, `TEMPERATURES`, "Sem pesquisa" = `"none"`), Agente (select, as the removed row did). The `origins` (origin_kind) group goes; its filter stays reachable as a chip.

Performance: `useMemo` for `filtered`, `facets`, `agents`, `cities`, `selected` ids, a `Map<id, name>` for `AiQuestionPanel.nameOf`, and the per-tab counts (from `facets`, no `items.filter` in JSX). No `.find`/`.filter` over `items` inside render loops.

Source-grep tests that must keep passing unchanged: `tests/unit/nav.test.ts` (`/agentes/novo` exactly once and behind `canCreate`; every `t.imports.button` within 500 chars after `canCreate && (`; contains `QualifyControls`) and `tests/unit/sources-view.test.ts:160` (`t.sources.search.maps`). So the ⋯ menu stays inside `LeadsTable.tsx`, wrapped in `canCreate && (`.

- [ ] **Step 1: Write the failing source test** in `tests/unit/leads-table-ui.test.ts`

```ts
const table = read("src/components/leads/LeadsTable.tsx");
test("old layers are gone", () => {
  for (const s of ["SHORTCUTS", "CONTACT_TABS", "LEAD_TABS", "t.leads.columns.proof", "t.leads.columns.approach"]) expect(table).not.toContain(s);
});
test("new layout pieces are wired", () => {
  for (const s of ["LEAD_STAGES", "facets.stages", "facets.segments", "activeFilterKeys(", "SelectionBar", "originText(", "openedFromList", "usePaged(", "leadsCsvAction"]) expect(table).toContain(s);
  expect(table).toMatch(/setTimeout\([\s\S]{0,200}?200\)/); // 200 ms debounce
});
test("counts and lookups are memoized, not recomputed in JSX", () => {
  expect(table).not.toMatch(/items\.filter\([^)]*leadInTab/);
  expect(table).not.toMatch(/items\.find\(/);
  expect(table.match(/useMemo\(/g)!.length).toBeGreaterThanOrEqual(4);
});
test("selection bar archives, unarchives and sets type in bulk", () => {
  const bar = read("src/components/leads/SelectionBar.tsx");
  for (const s of ["archiveLeadsAction", "unarchiveLeadsAction", "setLeadSegmentAction", "t.leads.archive.confirm", "AddToList", "EmailTools"]) expect(bar).toContain(s);
});
test("Filtros panel has origin list, 'Sem pesquisa' and agent", () => {
  const p = read("src/components/leads/FacetPanel.tsx");
  for (const s of ["facets.lists", "noResearch", "agents"]) expect(p).toContain(s);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/leads-table-ui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `LeadsTable.tsx`, `FacetPanel.tsx`, `SelectionBar.tsx` per the layout above. Keep the empty states (no leads / empty `?lista=`) as they are.

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run tests/unit/leads-table-ui.test.ts tests/unit/nav.test.ts tests/unit/sources-view.test.ts && npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/leads/LeadsTable.tsx src/components/leads/FacetPanel.tsx src/components/leads/SelectionBar.tsx tests/unit/leads-table-ui.test.ts
git commit -m "feat(leads): type and stage tabs, Filtros panel, chips, more menu, selection bar"
```

---

### Task 4: Lead modal: origin lists, type, archive, research section

**Files:**
- Modify: `src/components/leads/LeadDetail.tsx`
- Create: `src/components/leads/LeadTypePicker.tsx`
- Create: `src/components/leads/LeadArchiveButton.tsx`
- Test: `tests/unit/lead-detail-redesign.test.ts`

**Interfaces:**
- Consumes: Task 1 `segmentInputOf`, `derivedSegmentOf`, `SEGMENTS`, `Segment`, `stageOf`, `proofCount` (existing in `view.ts`), copy `origin.*`, `segmentPick.*`, `archive.*`, `research.*`, `segments.*`; Task 2 `originListsOf`, `archiveLeadsAction`, `unarchiveLeadsAction`, `setLeadSegmentAction`.
- Produces:
  - `LeadTypePicker({ leadId, value, derived }: { leadId: string; value: Segment | null; derived: Segment | null })` (client): a `<select>` labelled `segmentPick.label`; first option "" = `segmentPick.auto` filled with `segments[derived]` (or `segmentPick.autoNone`), then the three segments; on change calls `setLeadSegmentAction([leadId], v || null)`, shows the result message, `router.refresh()`.
  - `LeadArchiveButton({ leadId, archived }: { leadId: string; archived: boolean })` (client): `ActionButton` from `src/components/email/ActionButton.tsx`; archived=false → label `archive.archive`, `confirm={archive.confirm}`, runs `archiveLeadsAction([leadId])`; archived=true → `archive.unarchive`, no confirm, `unarchiveLeadsAction([leadId])`.

Changes in `LeadDetail.tsx`:
- Load `const origins = sender ? ((await originListsOf(supabase, [lead.id])).get(lead.id) ?? []) : []` (alongside the existing sender-only reads).
- Replace the "Listas:" line (l.135-139) with "Veio de:" + every origin as `fill(origin.item, { name, date: date(o.at) })` joined by ", ", or `origin.none` when empty. Keep the agent name in the existing meta line (`originLabel`) as today.
- Header: when `lead.archived_at` show a `Pill` with `fill(archive.archivedOn, { date: date(lead.archived_at) })`.
- Sender-only row under the meta lines: `LeadTypePicker` (`value = lead.segment`, `derived = derivedSegmentOf(segmentInputOf(lead, best, display.companyType ?? null, origins))`) and `LeadArchiveButton` (`archived = Boolean(lead.archived_at)`). Shown for closed leads too (archiving a Fechado lead is the main use); not shown to the closer.
- New `<section aria-labelledby="research-title">` titled `research.title` with a `<dl>`: Temperatura (`LB.temperature[best.temperature]` or `research.none`), Abordagem (`LB.approach[best.approach]` or `research.none`), Prova (`fill(t.leads.proofCount, { n: proofCount(checks.filter((k) => k.candidate_id === best.id)) })`, or `t.leads.unproven` when no `best`). Remove the approach from the meta line (it now lives here). Proof list section ("Provas") stays.

- [ ] **Step 1: Write the failing test** in `tests/unit/lead-detail-redesign.test.ts`

```ts
const detail = read("src/components/leads/LeadDetail.tsx");
test("modal shows every origin list with its date, or 'Sem lista de origem'", () => {
  expect(detail).toContain("originListsOf(");
  expect(detail).toContain("t.leads.origin.cameFrom");
  expect(detail).toContain("t.leads.origin.none");
  expect(detail).not.toContain("t.qualifier.lists");
});
test("type and archive controls are sender-only", () => {
  expect(detail).toMatch(/sender\s*&&[\s\S]{0,400}?LeadTypePicker/);
  expect(detail).toMatch(/sender\s*&&[\s\S]{0,600}?LeadArchiveButton/);
});
test("research section: temperature, approach, proof", () => {
  for (const s of ["research-title", "t.leads.research.temperature", "t.leads.research.approach", "proofCount("]) expect(detail).toContain(s);
});
test("archive button confirms before archiving, not before unarchiving", () => {
  const b = read("src/components/leads/LeadArchiveButton.tsx");
  expect(b).toContain("archiveLeadsAction([leadId])"); expect(b).toContain("unarchiveLeadsAction([leadId])");
  expect(b).toContain("t.leads.archive.confirm");
});
test("type picker can clear the override back to automatic", () => {
  const p = read("src/components/leads/LeadTypePicker.tsx");
  expect(p).toContain("setLeadSegmentAction([leadId]"); expect(p).toMatch(/\|\|\s*null/); expect(p).toContain("t.leads.segmentPick.auto");
});
```

Existing source tests that must keep passing: `tests/unit/nav.test.ts` (LeadDetail contains `getLead(`, `[0-9a-f-]{36}`, `notFound()`, `FieldList`), `tests/unit/lead-campaign.test.ts:31`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lead-detail-redesign.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the two components and the `LeadDetail.tsx` changes above.

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run tests/unit/lead-detail-redesign.test.ts tests/unit/nav.test.ts tests/unit/lead-campaign.test.ts && npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/leads/LeadDetail.tsx src/components/leads/LeadTypePicker.tsx src/components/leads/LeadArchiveButton.tsx tests/unit/lead-detail-redesign.test.ts
git commit -m "feat(leads): modal shows origin lists, type picker, archive button, research section"
```

---

### After all tasks (controller, not a task)

1. Whole branch: `npm run check` (typecheck, lint, tests, build, client-bundle check) from `app/`.
2. Back up prod, apply `0030_leads_archive_segment.sql`, then deploy.
3. Browser check on kolmeia.solutions (spec "Verification"): stage counts on type tab "Todos" add up to 966; archive one lead → it appears only in Arquivados → Desarquivar restores it to its previous stage; Lista de origem filter narrows rows and shows a chip; typing in search does not freeze.
