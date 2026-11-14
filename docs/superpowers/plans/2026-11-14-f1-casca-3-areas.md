# F1 Casca de 3 Áreas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app opens on a menu with exactly three areas (AGENTES / LEADS / CAMPANHAS DE E-MAIL) plus a ⚙ for Configurações; every current screen is reachable in its new home, and every old URL answers with a permanent redirect.
**Architecture:** Pure route move inside `src/app/(app)`: four new area folders (`agentes`, `leads`, `campanhas`, `configuracoes`), each with a small layout (title + sub-tabs) that wraps the existing pages unchanged in behaviour. Old URLs go through `redirects()` in `next.config.ts` (308). One pure helper `src/lib/nav.ts` holds the menu items and the "which tab is lit" rule; one client `SubNav` replaces `EmailNav`. No database change, no new data, no new env var.
**Tech Stack:** Next.js 16.4.5 App Router, React 19.3, Tailwind 4, TypeScript, vitest (node env, no DOM).
**Spec:** `kolmeia/docs/superpowers/specs/2026-11-14-kolmeia-3-areas-design.md` — sections 5.1, 5.4, 5.5 and 10 (row F1), decisions C10, C11.

`APP` = `kolmeia/app`. Every command runs from `APP` unless it starts with `cd`.

## Global Constraints
- F1 "pronto quando": "o Juan abre o app e vê só AGENTES / LEADS / CAMPANHAS; todas as telas atuais acessíveis; nenhum teste quebra; nenhuma tela do cliente diz \"pearchat\"".
- Menu: exactly 3 areas, in this order: `Agentes` → `/agentes`, `Leads` → `/leads`, `Campanhas de e-mail` → `/campanhas` (shown uppercase by the existing `uppercase` class). Configurações is NOT in the menu: a ⚙ link in the header to `/configuracoes` (spec 5.1, decisão do Juan).
- Phone (< 768 px, Tailwind `md`): the 3 areas become a fixed bottom bar (spec 5.1); the top tabs are hidden there. ⚙ stays in the header at every width. No horizontal scroll at 390 px.
- Redirects: `permanent: true` (308) for every old page route; query strings pass through (Next default, see `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/redirects.md`). C10: `/email/closer` and `/email/bloqueados` are permanent. `/onboarding`, `/login`, `/u/[token]`, `/api/*` do not change (spec 5.5).
- Final redirect table (each task adds its rows):

| source | destination | task |
|---|---|---|
| `/pesquisa` | `/agentes` | 1 |
| `/pesquisa/:id` | `/agentes/pesquisa/:id` | 1 |
| `/empresa` | `/configuracoes/empresa` | 2 |
| `/email/caixa` | `/configuracoes/caixas` | 2 |
| `/email/bloqueados` | `/configuracoes/bloqueados` | 2 |
| `/email/closer` | `/leads/closer` | 3 |
| `/email` | `/campanhas` | 4 |
| `/email/campanhas/:id` | `/campanhas/:id` | 4 |
| `/email/campanhas/:id/revisar` | `/campanhas/:id/revisar` | 4 |
| `/email/respostas` | `/campanhas/respostas` | 4 |

- Files move; they are not rewritten. Page bodies, queries, server actions, RLS reads and `canSend`/role checks stay as they are. Allowed edits inside a moved file: import paths, route strings (`href`, `redirect`, `revalidatePath`, `refresh`), the page's own title heading level (`h1` → `h2` when the area layout now owns the `h1`).
- Copy is Brazilian Portuguese; identifiers English; never the word "pearchat" anywhere in `src`. Header keeps showing the workspace name (client screen = NEAir HVAC; spec "Marca").
- New strings live in `src/messages/pt/areas.ts` (`export const areas = { agents, leads, settings }`, spread into `pt` in `index.ts` so they read `t.agents`, `t.leads`, `t.settings`). Exact values:
  - `t.agents`: `title: "Agentes"`, `soon: "Em breve: agentes que trabalham sozinhos, toda semana. Por enquanto, faça uma pesquisa avulsa aqui."`
  - `t.settings`: `title: "Configurações"`, `nav: { label: "Seções de Configurações", company: "Sua empresa", mailboxes: "Caixas de e-mail", blocked: "Bloqueados" }`
  - `t.leads`: `title: "Leads"`, `subtitle: "Empresas achadas pelas pesquisas, com prova."`, `nav: { label: "Seções de Leads", all: "Todos", closer: "Com a closer" }`, `soon: "Em breve: todos os leads numa lista só, sem empresa repetida. Por enquanto, abra o resultado de cada pesquisa:"`, `none: "Nenhuma pesquisa pronta ainda."`, `start: "Fazer uma pesquisa"`
  - `t.nav` (in `common.ts`, Task 5): `{ label: "Principal", agents: "Agentes", leads: "Leads", campaigns: "Campanhas de e-mail", settings: "Configurações" }` (keys `research`, `email`, `company` removed).
  - `t.email.title: "Campanhas de e-mail"`; `t.email.nav: { label: "Seções de Campanhas", campaigns: "Campanhas", replies: "Respostas" }` (Task 4; keys `mailbox`, `closer`, `blocked` removed).
- Closer role: unchanged in F1 (sees everything, read-only). The notice `t.email.readOnly` shown today by the E-mail layout is shown by each layout that now holds a former E-mail page: `campanhas`, `configuracoes`, `leads`.
- Path-dependent existing tests: only their path strings change — `tests/unit/research-rules.test.ts:257` (`pesquisa/actions.ts` → `agentes/actions.ts`), `tests/unit/guards.test.ts:220` (approver file → `campanhas/actions.ts`), `tests/unit/guards.test.ts:235` (R11 walk: the folders that hold former E-mail screens). No assertion is weakened.
- Next 16 differs from training data (`APP/AGENTS.md`): read the redirects doc above before Task 1.
- E3 is stopped with its Task 6 unreviewed (`kolmeia/.superpowers/sdd/e3/progress.md`). F1 moves files that E3 Task 6 touched (`email/campanhas/[id]/page.tsx`, `email/respostas/page.tsx`, `email/actions.ts`). Do not touch `.superpowers/sdd/e3/`; when E3 resumes (F4) its review reads `task-6-diff.txt` and applies fixes at the new paths of the table above.
- No git in `kolmeia/`: "Checkpoint" = run the command shown. Before Task 1: `cd kolmeia && tar -czf .backups/app-F1-2026-11-14.tgz --exclude node_modules --exclude .next app`. The SDD controller keeps snapshots and review packages in `kolmeia/.superpowers/sdd/f1/` with copies of `e3/pkg.sh` and `e3/next.sh` (`W=.superpowers/sdd/f1`), ledger `f1/progress.md`.
- Baseline (14/11/2026): `npx vitest run` → 706 passed | 3 todo, 25 files.

## Review Focus
1. **Old links with query strings** (`/pesquisa/<id>?view=conversa`, `/email/campanhas/<id>/revisar?i=2&modo=lista` in bookmarks or old e-mails to the owner) must land on the same screen with the same query. Owner: Task 5. Pin: runtime `curl` check of two query URLs in Step 5.
2. **A server action revalidates or redirects to an old path** (the move compiles, but after "Salvar"/"Enviar" the screen shows stale data or bounces through a redirect). Owner: Task 1. Pin: `no link, redirect or revalidation in src points at a moved route`.
3. **Wrong tab lit on nested screens** (`/campanhas/respostas` lighting both Campanhas and Respostas; `/agentes/pesquisa/<id>` lighting no area; a settings page lighting an area). Owner: Task 2. Pin: `the longest matching tab wins` and `settings pages light no main area`.
4. **First login lands nowhere**: onboarding today redirects to `/empresa`, and ⚙ points at `/configuracoes`, which has no screen of its own. Owner: Task 2. Pin: `onboarding sends a new workspace to the company profile at its new home` and `/configuracoes opens Sua empresa`.
5. **Phone bottom bar hides the last button of a page** (fixed bar over "Salvar"/"Enviar os de hoje") or shows next to the top tabs. Owner: Task 5. Pin: `the bottom bar is phone-only and the page leaves room for it`.

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/next.config.ts` (modify) | `redirects()` with the table above |
| `APP/src/lib/nav.ts` (create, T2; grows T4, T5) | `NavItem`, `activeHref`, `SETTINGS_TABS`, `LEADS_TABS`, `CAMPAIGN_TABS`, `MAIN_AREAS`, `SETTINGS_HREF` |
| `APP/src/components/SubNav.tsx` (create, T2) | client sub-tabs (style of today's `EmailNav`) |
| `APP/src/components/NavLinks.tsx` (rewrite, T5) | main menu: top tabs (≥ md) or bottom bar (< md) |
| `APP/src/components/Header.tsx` (modify, T5) | ⚙ link |
| `APP/src/components/email/EmailNav.tsx` (delete, T4) | replaced by `SubNav` |
| `APP/src/app/(app)/layout.tsx`, `page.tsx` (modify) | bottom bar + room for it; home → `/agentes` |
| `APP/src/app/(app)/agentes/**` (from `pesquisa/**`, T1) | AGENTES |
| `APP/src/app/(app)/configuracoes/**` (T2) | layout, `page.tsx` (redirect), `empresa/` (from `empresa/`), `caixas/` (from `email/caixa`), `bloqueados/` (from `email/bloqueados`) |
| `APP/src/app/(app)/leads/**` (T3) | layout, `page.tsx` (F1 placeholder), `closer/` (from `email/closer`) |
| `APP/src/app/(app)/campanhas/**` (from `email/**`, T4) | CAMPANHAS: overview, `[id]`, `[id]/revisar`, `respostas`, `actions.ts`, layout |
| `APP/src/messages/pt/areas.ts` (create, T1), `index.ts`, `common.ts`, `email.ts` (modify) | copy |
| `APP/tests/unit/routes.test.ts` (create, T1; grows) | redirect table, pages exist, no stale route literals |
| `APP/tests/unit/nav.test.ts` (create, T2; grows) | tab rule, menu items, shell, no "pearchat" |
| `APP/README.md` (modify, T5) | Portuguese: 3 areas + ⚙ and the route map |

---

### Task 1: AGENTES + redirect guard

**Files:** Move `src/app/(app)/pesquisa/{page.tsx,layout.tsx,actions.ts}` → `src/app/(app)/agentes/`, `pesquisa/[id]/page.tsx` → `agentes/pesquisa/[id]/page.tsx`. Modify `next.config.ts`, `src/app/(app)/page.tsx`, `src/components/research/{RunList,Results,Progress,PlanCard,QuestionsForm,NewResearchForm,RunControls}.tsx` (imports/hrefs), `src/components/email/Overview.tsx` (two `/pesquisa` links), `src/components/NavLinks.tsx` (href only), `src/messages/pt/index.ts`, `tests/unit/research-rules.test.ts:257`. Create `src/messages/pt/areas.ts`, `tests/unit/routes.test.ts`.
**Interfaces:** Produces `next.config.ts` default export with `redirects(): Promise<{ source: string; destination: string; permanent: true }[]>`; `tests/unit/routes.test.ts` with `const EXPECTED: { source: string; destination: string }[]` that Tasks 2-4 extend; `t.agents`.

- [ ] Step 1: Backup (Global Constraints) and confirm baseline `npx vitest run` → 706 passed | 3 todo.
- [ ] Step 2: Write `tests/unit/routes.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import nextConfig from "../../next.config";

const root = path.resolve(import.meta.dirname, "../..");
// Grows task by task until it equals the plan's redirect table.
const EXPECTED = [
  { source: "/pesquisa", destination: "/agentes" },
  { source: "/pesquisa/:id", destination: "/agentes/pesquisa/:id" },
];
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
/** "/agentes/pesquisa/:id?x=1" -> src/app/(app)/agentes/pesquisa/[id]/page.tsx */
const pageFileFor = (url: string) => path.join(root, "src/app/(app)", url.split("?")[0].replace(/:(\w+)/g, "[$1]"), "page.tsx");
/** Quoted forms of a moved route that must not appear in src: exact static path (optionally with ?query), or any path under a dynamic one. */
function forbiddenLiterals(source: string): string[] {
  const q = ['"', "'", "`"];
  if (source.includes(":")) return q.map((c) => c + source.slice(0, source.indexOf(":")));
  return q.flatMap((c) => [c + source + c, c + source + "?"]);
}
const redirects = async () => (await nextConfig.redirects!()) as { source: string; destination: string; permanent: boolean }[];
const sortBySource = <T extends { source: string }>(rows: T[]) => [...rows].sort((a, b) => a.source.localeCompare(b.source));
```
  Tests (one `describe("F1 routes")`):
  - `every old page route redirects permanently to its new home`: `expect(sortBySource(await redirects())).toEqual(sortBySource(EXPECTED.map((r) => ({ ...r, permanent: true }))))`.
  - `every redirect destination is a page`: `existsSync(pageFileFor(r.destination))` true for each.
  - `no page is left at a redirect source`: `existsSync(pageFileFor(r.source))` false for each.
  - `no link, redirect or revalidation in src points at a moved route`: for every `.ts`/`.tsx` under `src`, for every source, for every `forbiddenLiterals(source)` entry: `expect(text, file).not.toContain(lit)`.
- [ ] Step 3: Run `npx vitest run tests/unit/routes.test.ts` → FAIL (`redirects` undefined; pesquisa pages present).
- [ ] Step 4: Implement:
  - `next.config.ts`: add `async redirects()` returning the rows of this task with `permanent: true` (keep `serverExternalPackages`).
  - Move the files; fix imports `@/app/(app)/pesquisa/actions` → `@/app/(app)/agentes/actions`; every `/pesquisa` string → `/agentes`, every `/pesquisa/${…}` → `/agentes/pesquisa/${…}` (RunList, Results, Progress, `[id]/page.tsx`, `actions.ts` `revalidatePath`/`redirect`, Overview, NavLinks); `(app)/page.tsx` → `redirect("/agentes")`.
  - `areas.ts` with `agents` (exact copy above), spread in `index.ts`.
  - `agentes/layout.tsx`: above today's two-column body, an area header `<h1>{t.agents.title}</h1>` + `<p className="text-muted">{t.agents.soon}</p>`; the moved pages' own `h1` become `h2`.
  - `research-rules.test.ts:257`: path → `agentes/actions.ts`.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 710 passed | 3 todo.

### Task 2: CONFIGURAÇÕES (⚙ target) + SubNav

**Files:** Create `src/lib/nav.ts`, `src/components/SubNav.tsx`, `src/app/(app)/configuracoes/{layout.tsx,page.tsx}`, `tests/unit/nav.test.ts`. Move `src/app/(app)/empresa/{page.tsx,ProfileForm.tsx,actions.ts}` → `configuracoes/empresa/`; `email/caixa/page.tsx` → `configuracoes/caixas/page.tsx`; `email/bloqueados/page.tsx` → `configuracoes/bloqueados/page.tsx`. Modify `next.config.ts`, `src/app/(app)/email/actions.ts` (`refresh` paths), `src/app/onboarding/actions.ts`, `src/components/email/EmailNav.tsx` (drop the two moved entries), `src/components/email/Overview.tsx` (`/email/caixa` link), `src/components/NavLinks.tsx` (`/empresa` → `/configuracoes`), `src/messages/pt/areas.ts`, `tests/unit/routes.test.ts`, `tests/unit/guards.test.ts:235`.
**Interfaces:** Consumes `EXPECTED` (Task 1). Produces in `src/lib/nav.ts`: `export type NavItem = { href: string; label: string }`; `export function activeHref(pathname: string, hrefs: readonly string[]): string | null` (the longest `href` with `pathname === href || pathname.startsWith(href + "/")`, else `null`); `export const SETTINGS_TABS: readonly NavItem[]` = Sua empresa `/configuracoes/empresa`, Caixas de e-mail `/configuracoes/caixas`, Bloqueados `/configuracoes/bloqueados`. In `SubNav.tsx`: `export function SubNav({ label, items }: { label: string; items: readonly NavItem[] })` ("use client", `usePathname` + `activeHref`, `aria-current="page"` on the lit item, the classes of today's `EmailNav`). `t.settings`.

- [ ] Step 1: Write the failing tests.
  `tests/unit/nav.test.ts` (`describe("F1 nav")`):
  - `the longest matching tab wins`: `activeHref("/campanhas/respostas", ["/campanhas", "/campanhas/respostas"])` → `"/campanhas/respostas"`; `activeHref("/campanhas/123/revisar", same)` → `"/campanhas"`; `activeHref("/leads/closer", ["/leads", "/leads/closer"])` → `"/leads/closer"`; `activeHref("/agentes/pesquisa/abc", ["/agentes", "/leads", "/campanhas"])` → `"/agentes"`.
  - `a prefix without a slash does not match`: `activeHref("/campanhasx", ["/campanhas"])` → `null`.
  - `settings pages light no main area`: `activeHref("/configuracoes/caixas", ["/agentes", "/leads", "/campanhas"])` → `null`; `SETTINGS_TABS.map((i) => [i.label, i.href])` equals `[["Sua empresa", "/configuracoes/empresa"], ["Caixas de e-mail", "/configuracoes/caixas"], ["Bloqueados", "/configuracoes/bloqueados"]]`.
  `tests/unit/routes.test.ts`: append the 3 Task 2 rows to `EXPECTED`; add
  - `C10 /email/bloqueados redirects permanently to Configurações`: the row `{ source: "/email/bloqueados", destination: "/configuracoes/bloqueados", permanent: true }` is in `await redirects()`.
  - `onboarding sends a new workspace to the company profile at its new home`: `src/app/onboarding/actions.ts` contains `redirect("/configuracoes/empresa")`.
  - `/configuracoes opens Sua empresa`: `src/app/(app)/configuracoes/page.tsx` exists and contains `redirect("/configuracoes/empresa")`.
- [ ] Step 2: Run `npx vitest run tests/unit/nav.test.ts tests/unit/routes.test.ts` → FAIL (`nav.ts` missing; redirects table short).
- [ ] Step 3: Implement: `nav.ts`, `SubNav.tsx`; redirect rows; moves; `configuracoes/layout.tsx` = `h1 t.settings.title` + `<SubNav label={t.settings.nav.label} items={SETTINGS_TABS} />` + the closer notice (`workspace?.role === "closer"` → `<Notice tone="info">{t.email.readOnly}</Notice>`, as in `email/layout.tsx`); `configuracoes/page.tsx` = `redirect("/configuracoes/empresa")`; moved pages import actions from `@/app/(app)/email/actions` (Task 4 moves it again); `email/actions.ts` `refresh("/email/caixa")` → `"/configuracoes/caixas"`, `"/email/bloqueados"` → `"/configuracoes/bloqueados"`; onboarding → `redirect("/configuracoes/empresa")`; the moved company page's `h1` → `h2`; `guards.test.ts:235` R11 walk adds `src/app/(app)/configuracoes`.
- [ ] Step 4: Run the two test files → PASS.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 716 passed | 3 todo.

### Task 3: LEADS (placeholder + Com a closer)

**Files:** Create `src/app/(app)/leads/{layout.tsx,page.tsx}`. Move `email/closer/page.tsx` → `leads/closer/page.tsx`. Modify `next.config.ts`, `src/app/(app)/email/actions.ts` (`revalidatePath("/email/closer")`), `src/components/email/EmailNav.tsx` (drop closer entry), `src/lib/nav.ts`, `src/messages/pt/areas.ts`, `tests/unit/routes.test.ts`, `tests/unit/nav.test.ts`, `tests/unit/guards.test.ts:235`.
**Interfaces:** Consumes `SubNav`, `activeHref`, `NavItem` (Task 2). Produces `LEADS_TABS: readonly NavItem[]` = Todos `/leads`, Com a closer `/leads/closer`; `t.leads`.

- [ ] Step 1: Failing tests. `routes.test.ts`: append the `/email/closer` row; add `C10 /email/closer redirects permanently to LEADS, com a closer` (row with `permanent: true` present). `nav.test.ts`: `the LEADS tabs are Todos and Com a closer` (`LEADS_TABS` labels/hrefs equal `[["Todos", "/leads"], ["Com a closer", "/leads/closer"]]`).
- [ ] Step 2: Run both files → FAIL.
- [ ] Step 3: Implement: redirect row; move (import `refreshBriefAction` from `@/app/(app)/email/actions`); `revalidatePath("/leads/closer")`; `leads/layout.tsx` = `h1 t.leads.title` + subtitle + `<SubNav label={t.leads.nav.label} items={LEADS_TABS} />` + closer notice; `leads/page.tsx` (server, RLS as the user, like `agentes/layout.tsx`): `t.leads.soon`, then `research_runs` of the workspace with `status = 'done'`, newest first, limit 50, each a link to `/agentes/pesquisa/${id}` showing title, `t.research.partialTag` when `is_partial`, and date (`when` from `components/email/format`); none → `t.leads.none` + link `t.leads.start` to `/agentes`. No new query on candidates (unified LEADS is F3). `guards.test.ts:235` adds `src/app/(app)/leads`.
- [ ] Step 4: Run both files → PASS.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 718 passed | 3 todo.

### Task 4: CAMPANHAS DE E-MAIL

**Files:** Move `src/app/(app)/email/{page.tsx,layout.tsx,actions.ts}` → `src/app/(app)/campanhas/`, `email/campanhas/[id]/page.tsx` → `campanhas/[id]/page.tsx`, `email/campanhas/[id]/revisar/page.tsx` → `campanhas/[id]/revisar/page.tsx`, `email/respostas/page.tsx` → `campanhas/respostas/page.tsx`; `email/` must be empty and removed. Delete `src/components/email/EmailNav.tsx`. Modify `next.config.ts`, `src/lib/nav.ts`, `src/messages/pt/email.ts`, importers of `@/app/(app)/email/actions` (`components/email/{forms,ReplyControls,Overview,MessageEditor}.tsx`, `configuracoes/caixas`, `configuracoes/bloqueados`, `leads/closer`), `/email…` strings in `components/email/{Overview,MessageEditor}.tsx` and the moved pages/actions, `tests/unit/routes.test.ts`, `tests/unit/nav.test.ts`, `tests/unit/guards.test.ts:220,235`.
**Interfaces:** Consumes `SubNav`, `NavItem`. Produces `CAMPAIGN_TABS: readonly NavItem[]` = Campanhas `/campanhas`, Respostas `/campanhas/respostas`; server actions now at `@/app/(app)/campanhas/actions` (same names).

- [ ] Step 1: Failing tests. `routes.test.ts`: append the 4 Task 4 rows (`EXPECTED` now equals the full table). `nav.test.ts`: `the campaign tabs are Campanhas and Respostas only` (`CAMPAIGN_TABS` labels/hrefs equal `[["Campanhas", "/campanhas"], ["Respostas", "/campanhas/respostas"]]`).
- [ ] Step 2: Run both files → FAIL.
- [ ] Step 3: Implement: rows; moves (relative `../../actions` imports become `../actions` / `../../actions`); every `/email` route string → its new path (the guard test lists any you miss; `refresh()`'s `revalidatePath("/email", "layout")` → `("/campanhas", "layout")`); layout uses `<SubNav label={t.email.nav.label} items={CAMPAIGN_TABS} />`, keeps title/subtitle/closer notice; `email.ts` copy per Global Constraints; `guards.test.ts:220` → `["src/app/(app)/campanhas/actions.ts"]`; `:235` replaces `src/app/(app)/email` with `src/app/(app)/campanhas`.
- [ ] Step 4: Run both files → PASS; `test ! -d "src/app/(app)/email"` → exit 0.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 719 passed | 3 todo.

### Task 5: Shell — 3 areas, ⚙, phone bottom bar, README, full check

**Files:** Modify `src/lib/nav.ts`, `src/components/NavLinks.tsx`, `src/components/Header.tsx`, `src/app/(app)/layout.tsx`, `src/messages/pt/common.ts` (+ `Overview.tsx` where it used `t.nav.research` → `t.research.title`), `tests/unit/nav.test.ts`, `README.md`.
**Interfaces:** Consumes `activeHref`, `NavItem`. Produces `MAIN_AREAS: readonly NavItem[]` (3 items, order and copy of Global Constraints), `SETTINGS_HREF = "/configuracoes"`; `NavLinks({ variant }: { variant: "top" | "bottom" })`.

- [ ] Step 1: Failing tests in `nav.test.ts` (`describe("F1 shell")`):
  - `the menu has exactly the 3 areas, in order`: `MAIN_AREAS.map((i) => [i.label, i.href])` equals `[["Agentes", "/agentes"], ["Leads", "/leads"], ["Campanhas de e-mail", "/campanhas"]]`; no item href starts with `SETTINGS_HREF`.
  - `the header links ⚙ to Configurações`: `Header.tsx` contains `SETTINGS_HREF` and `t.nav.settings`.
  - `the bottom bar is phone-only and the page leaves room for it`: `NavLinks.tsx` contains `md:hidden` and `fixed` and `hidden md:flex`; `(app)/layout.tsx` contains `variant="bottom"` and `pb-24` and `md:pb-8`.
  - `no screen says pearchat`: no file under `src` matches `/pearchat/i`.
- [ ] Step 2: Run `npx vitest run tests/unit/nav.test.ts` → FAIL.
- [ ] Step 3: Implement: `MAIN_AREAS`/`SETTINGS_HREF`; `NavLinks` top = today's tab row with `hidden md:flex`, bottom = `<nav>` `fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-line bg-surface md:hidden pb-[env(safe-area-inset-bottom)]`, each link `min-h-14`, centred, text may wrap (no short label); both lit by `activeHref(pathname, MAIN_AREAS.map((a) => a.href))` with `aria-current="page"`. `Header`: `<Link href={SETTINGS_HREF} aria-label={t.nav.settings} title={t.nav.settings}>` with `<span aria-hidden>⚙</span>`, before "Sair", min 44×44 px. `(app)/layout.tsx`: `<NavLinks variant="bottom" />` after `<main>`; `main` padding `pt-8 pb-24 md:pb-8`; Header renders `<NavLinks variant="top" />`. `common.ts` `nav` per Global Constraints. README (Portuguese): line 3 → "Três áreas: **Agentes**, **Leads** e **Campanhas de e-mail**; ⚙ **Configurações** (Sua empresa, Caixas de e-mail, Bloqueados)"; line 43 "em Caixa de envio" → "em ⚙ Configurações > Caixas de e-mail"; new short section "Rotas antigas" with the redirect table.
- [ ] Step 4: Run `npx vitest run tests/unit/nav.test.ts` → PASS.
- [ ] Step 5: Checkpoint, full:
  - `npm run check` → typecheck, lint, 723 passed | 3 todo, build, bundle check green. The build's route list shows `/agentes`, `/agentes/pesquisa/[id]`, `/leads`, `/leads/closer`, `/campanhas`, `/campanhas/[id]`, `/campanhas/[id]/revisar`, `/campanhas/respostas`, `/configuracoes`, `/configuracoes/empresa`, `/configuracoes/caixas`, `/configuracoes/bloqueados`, and no `/pesquisa`, `/email`, `/empresa`.
  - Runtime redirects (no Supabase env needed; redirects run before the proxy): start `npx next start -p 3107` in the background, then for each of `/email/closer`, `/email/bloqueados`, `/pesquisa/abc?view=conversa`, `/email/campanhas/abc/revisar?i=2&modo=lista` run `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "http://localhost:3107<path>"` → `308 http://localhost:3107/leads/closer`, `308 …/configuracoes/bloqueados`, `308 …/agentes/pesquisa/abc?view=conversa`, `308 …/campanhas/abc/revisar?i=2&modo=lista`. Stop the server.
  - Browser check (only if `APP/.env.local` with Supabase keys exists; otherwise write "NOT browser-checked" in the ledger): at 1280 px and 390 px, the menu shows only the 3 areas + ⚙, every tab of every area opens, no horizontal scroll at 390 px, the last button of `/configuracoes/empresa` is not under the bottom bar.

---

## Fora da F1
- Galeria, chat guiado, tabela `agents`, lista "Meus agentes" (F2). AGENTES em F1 = Pesquisa avulsa atual + uma linha "Em breve".
- Papéis owner/sdr/closer e esconder AGENTES/CAMPANHAS da closer (J2: F2 papéis, F5 login). F1 mantém o comportamento de hoje (closer vê tudo, só leitura, com aviso).
- LEADS unificado, filtros (Busca/Temperatura/Agente/Status), tela do lead e botões "Passar pra closer / Pôr em campanha / Pôr na ligação / Descartar" (F3, F5; C13). Em F1 "Passar pra closer" continua onde está hoje (Respostas e Painel).
- "Acesso à IA" em ⚙: não existe tela hoje (só tabela `ai_access`); não é criada na F1.
- Faixa de avisos em CAMPANHAS e campanha recebendo seleção de LEADS (F4).
- Aba "Caixa de entrada" (unibox) em CAMPANHAS: não existe tela de caixa de entrada hoje.
- Visual novo de `kolmeia/design-telas/Main.dc.html` e marca "⬡ Kolmeia" no cabeçalho: F1 reusa o estilo atual e mantém o nome do workspace (tela do cliente = NEAir HVAC).
