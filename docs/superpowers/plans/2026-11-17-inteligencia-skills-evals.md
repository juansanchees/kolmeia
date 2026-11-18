# Inteligência I1 + I2 (skills de GTM + provas automáticas) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Caçador loads versioned GTM playbooks ("skills") by research stage, every AI call records the skill version, and a local eval harness scores a real Caçador run against the gold lists (same niche + town) so a skill/prompt/model change ships only when the score goes up. The research form and the agent wizard offer "Rápido / Caprichado" on top of the existing rigors.

**Architecture:** I2 is built first so the current prompts get a baseline score before any skill text lands. Pure scoring lives in `src/lib/evals/` (synthetic-fixture tests); the runner reuses the `smoke-engine` pattern (real engine + PGlite + guarded transport) under `scripts/eval/`, reads the gold xlsx by absolute path at run time and writes reports outside the repo. I1 is static text in `src/lib/ai/skills/gtm.ts`, concatenated into each research prompt's `SYSTEM` (cache-stable, no engine change); the bundle version `GTM_VERSION` is appended to each `PROMPT_VERSION`, so `ai_calls.prompt_version` (per call, per `run_id`) records it with no migration. D7 relabels the two rigors the picker offers; no new axis.

**Tech Stack:** Next.js 16, TypeScript, zod 4, vitest 5 + PGlite, `read-excel-file` 9 (already a dependency), `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-11-17-motor-de-dados-design.md` §11 (I1, I2, 11.2 rules) and D7. Related: `docs/superpowers/specs/2026-11-16-learning-loop-design.md` (profile hints stay in the user message; skills never replace them). Method source (private, outside the repo): `Hvac - Project/docs/pesquisa-padrao-ouro.md` §2 (7 passadas) and §6 (uso como avaliação).

## Global Constraints
- App dir: `kolmeia/.claude/worktrees/f7-leads-redesign/app`, branch `leads-redesign`. Push/deploy only by the orchestrator.
- Public repo: skills hold the **generic method only**: no real company, person, street address, phone, e-mail or URL; examples use `Example Rd` / `example.com`. Gold data (real companies and people) **never** enters the repo: read by absolute path from env at run time; tests use synthetic fixtures only.
- Unit tests never touch the network (`FakeTransport` / `happyTransport()` from `tests/engine/`). Real evals run only via `scripts/vitest.smoke.config.mts`, never in `npm test`.
- Every real eval run has an explicit `EVAL_MAX_USD` and is an **ORCHESTRATOR step that needs Juan's ok** (state the cap in US$ before running).
- `ai_calls.prompt_version` is `<= 40` chars (0002 check constraint). Changing any prompt or skill text bumps its version (rule R19/P7).
- No migration in this plan; `hunter_caps` (0010) and `DEFAULT_CAPS` unchanged.
- Every UI string in pt AND en message files (en `satisfies Widen<typeof pt>`); never the word "LinkedIn" in UI copy; design from `@/components/ui` (navy `#0F1B3D`, honey `#F5A400` accents, `DarkChoice`/`StepSet` as today).
- Rule 11.2: a skill reaches a prompt only if I2 measures that prompt. The engine's 6 research steps are measured; outreach prompts are not (Task 9 is blocked on Juan).

## Review Focus
1. A case whose town has 0 gold rows (spelling variant, e.g. "East Falmouth") → the CLI refuses that case **before any AI call** instead of spending money for a 0/0 score (Task 3 test `refuses case with no gold rows`).
2. A run that ends with 0 companies, or a 0-hit run → scores are zeros, `costPerLead`/`costPerHit` are `null` (never `NaN`/`Infinity`), verdict `hold` (Task 1 test).
3. Eval cap reached mid-run → no call starts once `spent + allowance > cap`, the partial result is still scored and flagged `partial: true` (Task 2 test).
4. Name variants between app and gold ("Acme Builders, Inc." vs "ACME BUILDERS LLC", `www.` domains, `(508)` phones; "José A. Silva" vs "Jose Silva") → counted as matches (Task 1 tests).
5. Baseline file from another case/rigor/old schema → `compareScores` compares only identical `caseId+rigor` pairs and returns `hold` with "faltou o par …" when a pair is missing (Task 1 test).

---

### Task 1: Gold reader and scorer (pure)
**Para o Juan:** a régua: lê a lista padrão-ouro de uma cidade e dá nota a uma busca (empresas certas, provas, decisor certo, custo por lead). Sem IA, sem gasto.

**Files:**
- Create: `src/lib/evals/gold.ts`, `src/lib/evals/score.ts`
- Modify: `src/lib/leads/baseline.ts` (export the existing `matchSets` as `matchCompanies`; `baselineReport` keeps working)
- Test: `tests/unit/eval-score.test.ts` (synthetic rows only)

**Interfaces:**
- Produces (`gold.ts`):
```ts
export type GoldRow = { name: string; phone?: string; website?: string; city: string; hot: boolean; askFor: string | null; jobAddress: string | null };
export type Sheet = { sheet: string; data: unknown[][] };
/** Sheet "Todos" = universe; "🔥 Ligar direto" + "🔥 Grandes (fornecedor)" = hot (askFor = "Perguntar por", jobAddress = "Maior obra – endereço"). Columns by header name. Cities compared trimmed, case/accents-insensitive. */
export function goldFromSheets(sheets: Sheet[], cities: string[]): GoldRow[];
```
- Produces (`score.ts`):
```ts
export type EvalCandidate = { name: string; website: string | null; phone: string | null; askForName: string | null; hook: string | null; foundAtUrl: string | null; okWithEvidence: number; verified: boolean; refuted: boolean };
export type EvalScore = { caseId: string; rigor: Rigor; gtmVersion: string; found: number; hits: number; hotHits: number; goldTotal: number; goldHot: number;
  precision: number; hotCoverage: number; proofRate: number; dmMatches: number; dmChecked: number; hookRight: number;
  spentUsd: number; costPerLead: number | null; costPerHit: number | null; partial: boolean };
export function evalCandidates(rows: CandidateRow[], checks: CheckWithEvidence[]): EvalCandidate[];
export function scoreRun(i: { caseId: string; rigor: Rigor; gtmVersion: string; found: EvalCandidate[]; gold: GoldRow[]; spentUsd: number; partial: boolean }): EvalScore;
export function quality(s: EvalScore): number; // hits + 2*hotHits + 2*dmMatches
export function compareScores(base: EvalScore[], next: EvalScore[]): { verdict: "ship" | "hold"; lines: string[] };
```
Rules: `found` excludes `refuted`; a hit uses `matchCompanies` (name/domain/phone, existing dedupe keys); `proofRate` = found with `foundAtUrl` and `okWithEvidence >= 1` ÷ found; `dmChecked` = hot hits whose gold has `askFor`; `dmMatches` = those where `askForName` matches (accents/case stripped, same last token and same first initial); `hookRight` = hot hits whose hook contains the gold `jobAddress` house number; money rounded to 4 decimals. Ship gate (Claude — conferir, see open items): over the shared pairs, `Σquality(next) >= Σquality(base) + 2` AND `proofRate(next) >= proofRate(base) - 0.05` AND `costPerLead(next) <= 1.25 × costPerLead(base)` (null cost = fail).

- [ ] **Step 1: Failing tests** in `tests/unit/eval-score.test.ts`:
  - `goldFromSheets keeps only the case towns and marks hot rows`: two sheets (Todos 3 rows in 2 towns, Ligar direto 1 row with Perguntar por) → for `["Townville"]` returns 2 rows, 1 `hot: true` with `askFor: "Pat Example"`.
  - `goldFromSheets matches "townville " and "TOWNVILLE"`; a hot row also in Todos appears once.
  - `name variants are hits`: found `Acme Builders, Inc.` / gold `ACME BUILDERS LLC` → `hits: 1`; `https://www.bay.example/` vs `bay.example` → hit; `(508) 555-0100` vs `+1 508 555 0100` → hit.
  - `decision maker match`: `José A. Silva` vs `Jose Silva` → `dmMatches: 1`; `Maria Silva` vs `Jose Silva` → 0.
  - `empty run is zeros`: no found → `{ found: 0, hits: 0, precision: 0, proofRate: 0, costPerLead: null, costPerHit: null }`.
  - `refuted companies do not count`; `proofRate` = 0.5 when 1 of 2 has `foundAtUrl` + an ok check with evidence.
  - `compareScores ship`: base quality 4, next 6, same proof, cost +10% → `ship`. `hold` when next quality 5; `hold` when proof drops 0.1; `hold` when cost +30%; `hold` with a line containing `faltou` when next has no `falmouth/strict` pair.
- [ ] **Step 2:** `npx vitest run tests/unit/eval-score.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** both files (pure, no I/O); export `matchCompanies` from `baseline.ts`.
- [ ] **Step 4:** test PASS; `npx vitest run tests/unit/baseline.test.ts` still PASS.
- [ ] **Step 5: Commit** `feat(evals): gold reader and run scorer`.

### Task 2: Eval runner (one case, one rigor)
**Para o Juan:** a máquina que roda o Caçador de verdade numa cidade, num banco de teste local, e para sozinha no teto de gasto.

**Files:**
- Create: `scripts/eval/run-case.ts`, `scripts/eval/cases.ts`
- Test: `tests/engine/eval-run.test.ts` (with `happyTransport()`; no network)

**Interfaces:**
- Consumes: `evalCandidates` (Task 1); `createRun`, `submitAnswers`, `approvePlan` (`src/lib/research/commands.ts`); `advance`, `needsAdvance` (`engine.ts`); `TestDb`, `as` (`tests/db/helpers`); `SqlResearchStore` (`tests/engine/sql-store`). Same setup as `scripts/smoke-engine.smoke.ts` (user, workspace, synthetic HVAC company profile).
- Produces:
```ts
export type EvalCase = { id: string; request: string; region: string; goldCities: string[] };
export const EVAL_CASES: readonly EvalCase[]; // falmouth (Falmouth, MA), waltham (Waltham, MA), mashpee (Mashpee, MA); request = the smoke-engine request text
export const CALL_ALLOWANCE_USD = 0.3;
export function runEvalCase(o: { transport: AiTransport; evalCase: EvalCase; rigor: Rigor; capUsd: number }):
  Promise<{ candidates: EvalCandidate[]; spentUsd: number; partial: boolean; versions: Record<string, string> }>;
```
Flow: questions → first option of each → plan → `approvePlan` with `DEFAULT_CAPS[rigor]` but `maxCostUsd = min(DEFAULT_CAPS[rigor].maxCostUsd, capUsd)` → `advance` until `!needsAdvance` or 80 steps. A guard transport throws `AiTransportFailure("eval stop")` before a call when `spent + CALL_ALLOWANCE_USD > capUsd` → `partial = true`. `versions` = distinct `task → prompt_version` from `ai_calls` of the run. Closes PGlite in `finally`.

- [ ] **Step 1: Failing tests:** `happy run returns scored-ready candidates` (≥ 1 candidate, `spentUsd > 0`, `partial: false`, `versions.research_collect` defined); `cap stops before the call` (`capUsd: 0.31` → `partial: true`, `spentUsd <= 0.31`); `goldCities of every case are non-empty and ids unique`.
- [ ] **Step 2:** `npx vitest run tests/engine/eval-run.test.ts` → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5: Commit** `feat(evals): local eval runner`.

### Task 3: Eval command with money and privacy guards
**Para o Juan:** o comando que o Claude roda: exige teto em US$, lê a lista ouro só de fora do repositório, grava o relatório fora do repositório e diz "pode entrar" ou "segura".

**Files:**
- Create: `scripts/eval/env.ts`, `scripts/eval.smoke.ts`
- Modify: `package.json` (script `"eval": "vitest run --config scripts/vitest.smoke.config.mts eval"`)
- Test: `tests/unit/eval-env.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `loadSmokeEnv`, `redact` (`scripts/smoke-env.ts`); `AnthropicTransport`; `read-excel-file/node` default export (returns `{ sheet, data }[]`).
- Produces:
```ts
export type EvalEnv = { goldFile: string; outDir: string; maxUsd: number; rigors: Rigor[]; caseIds: string[]; baseline: string | null };
export const EVAL_HARD_MAX_USD = 20;
export function evalEnv(env: Record<string, string | undefined>, repoRoot: string): EvalEnv; // throws Error with a plain message
export function preflight(cases: EvalCase[], goldByCase: Record<string, GoldRow[]>): void; // throws "case <id> has no gold rows"
export function pairBudgets(maxUsd: number, caseIds: string[], rigors: Rigor[]): { caseId: string; rigor: Rigor; capUsd: number | null }[]; // null = skipped
```
Env: `EVAL_GOLD_FILE` (absolute, exists, outside `repoRoot`), `EVAL_OUT` (dir outside `repoRoot`), `EVAL_MAX_USD` (required, `0 < x <= 20`), `EVAL_RIGOR` (`careful` | `strict` | `both`, default `careful`), `EVAL_CASES` (comma ids, default `falmouth`), `EVAL_BASELINE` (optional JSON from an earlier run), `SMOKE_ENV_FILE`. Pairs run in order (cases × rigors); each pair gets `min(DEFAULT_CAPS[rigor].maxCostUsd, what is left of EVAL_MAX_USD)`; a pair with less than `CALL_ALLOWANCE_USD` left is skipped and listed as skipped in the report. Output: `EVAL_OUT/eval-<YYYY-MM-DD>-<gtmVersion>.json` (`EvalScore[]` + versions) and `.md` (per pair: the score fields; company names only in the `.md`, which stays outside the repo). Console prints only aggregate numbers and the verdict line (no names).

- [ ] **Step 1: Failing tests:** `requires EVAL_MAX_USD`; `refuses EVAL_MAX_USD 25` and `0`; `refuses gold file inside the repo`; `refuses EVAL_OUT inside the repo`; `both → ["careful","strict"]`; `refuses case with no gold rows` (preflight); `pairBudgets(8, ["falmouth"], ["careful","strict"])` → caps `3` and `5`; with `6` → `3` and `3`; with `3.2` → `3` and `null`.
- [ ] **Step 2:** `npx vitest run tests/unit/eval-env.test.ts` → FAIL. **Step 3:** implement (`eval.smoke.ts` stays thin: env → read gold → preflight → for each pair `runEvalCase` with `AnthropicTransport` → `scoreRun` → write files → `compareScores` when `EVAL_BASELINE`). **Step 4:** PASS + `npm run typecheck`. **Step 5: Commit** `feat(evals): eval command with cost cap`.

### Task 4: ORCHESTRATOR — baseline score of today's prompts (needs Juan's ok)
**Para o Juan:** primeira medição, antes de mexer na IA: quanto o Caçador de hoje acerta em Falmouth contra a lista ouro, no Rápido e no Caprichado. Gasto máximo US$ 8.

- [ ] Ask Juan: "Rodar a prova base: Falmouth, Rápido (US$ 3) + Caprichado (US$ 5), teto US$ 8?" Wait for yes.
- [ ] Run: `EVAL_GOLD_FILE="/Users/juansanchees/Documents/Hvac - Project/data/gold/hot_leads_builders_boston_cape.xlsx" EVAL_OUT="/Users/juansanchees/Documents/Hvac - Project/data/evals" EVAL_MAX_USD=8 EVAL_RIGOR=both EVAL_CASES=falmouth SMOKE_ENV_FILE=<app .env.local path> npm run eval` (from `app/`).
- [ ] Report to Juan: a table per rigor (achadas, acertos, quentes, provas, decisor, custo por lead) + the D7 line "contra o ouro: X de Y quentes". Save the JSON path as the baseline for Task 7. `git status` shows nothing new under `kolmeia/`.

### Task 5: GTM skills text and registry (I1)
**Para o Juan:** os 7 manuais de prospecção que a IA passa a ler (cliente ideal, caçar sinal de obra, dossiê, gancho, cadência, objeções, qualificação curta), com número de versão.

**Files:**
- Create: `src/lib/ai/skills/gtm.ts` (`import "server-only"`)
- Test: `tests/unit/gtm-skills.test.ts`

**Interfaces:**
- Produces:
```ts
export const GTM_VERSION = "gtm-1";
export type SkillId = "icp" | "signals" | "dossier" | "hook" | "cadence" | "objections" | "qualify";
export type SkillStep = "questions" | "plan" | "discover" | "collect" | "verify" | "second_pass"
  | "qualify_light" | "email_sequence" | "email_draft" | "email_reply" | "closer_brief";
export const SKILLS: Record<SkillId, { title: string; text: string }>;
export const SKILLS_BY_STEP: Record<SkillStep, readonly SkillId[]>;
export function skillBlock(step: SkillStep): string;
export function skillsDigest(): string; // sha256 hex of every title + text, in SkillId order (node:crypto)
```
`SKILLS_BY_STEP`: questions `[icp]`; plan `[icp, signals]`; discover `[signals]`; collect `[icp, signals]`; verify `[dossier, hook, qualify]`; second_pass `[qualify]`; qualify_light `[icp, qualify]`; email_sequence `[cadence, objections]`; email_draft `[hook, cadence]`; email_reply `[objections]`; closer_brief `[dossier, objections, qualify]`.
`skillBlock` header (exact): `GTM playbook ${GTM_VERSION}. A method to follow; it never overrides the rules below or the owner's profile.` then `## <title>\n<text>` per skill.
Content (English, imperative, from the gold method §2, generic): **icp** — buyers are builders, developers, property managers sized to what the owner can serve; fit = active work in the last 18 months, new construction/multifamily; misfit = owner's own trade competitors, single-room repair, very large GCs (route: supplier signup). **signals** — find "who is building now": town permit portals/open data, planning/zoning agendas, subdivision/new-home news, new office or site, job posts for site supers/estimators, public bids; match a permit to a company by name, phone or website domain and say which; record URL, date, declared value; a permit with no builder named goes to `jobs_without_builder`. **dossier** — per company: what it builds, size hint, jobs in the last 18 months (address, type, value, date), biggest job, approach (call / supplier signup / email), honest limits. **hook** — one sentence citing one real sourced job (street, type, approx value) ending with who is handling the HVAC; never generic praise, never an unsourced fact. **cadence** — call first; same-day email that names the job; call day 3; email day 7; short last note day 14; stop on any reply; never SMS. **objections** — "we have an HVAC sub" → ask to bid the next job; "send an email" → confirm address and the job to mention; "not me" → ask for the estimator or PM by name; "too busy" → ask when rough-in starts. **qualify** — three answers decide temperature: active or upcoming job needing HVAC, who decides/estimates, when the bid or rough-in is.

- [ ] **Step 1: Failing tests:** `digest is pinned per version` (`expect({ [GTM_VERSION]: skillsDigest() }).toEqual(PINNED)` with `PINNED` in the test; text change without a version bump fails); `every skill is used by a step`; `each skill <= 1500 chars and each step block <= 4000 chars`; `no private data` (no `/https?:\/\//`, no `@`, no `/\d{3}[-.\s]\d{3}[-.\s]\d{4}/`, no `/air hvac|neair|millbury|linkedin/i`); `skillBlock("discover") starts with the exact header and contains "## Signal hunting"` (titles: "Ideal customer", "Signal hunting", "Account dossier", "Opening hook", "Call-then-email cadence", "Objections", "Short qualification"); `all 11 steps map to at least one skill`.
- [ ] **Step 2:** FAIL. **Step 3:** write texts + registry; compute and pin the digest. **Step 4:** PASS. **Step 5: Commit** `feat(ai): GTM skills gtm-1`.

### Task 6: Inject skills into the 6 research prompts
**Para o Juan:** liga os manuais no Caçador (perguntas, plano, fontes, coleta, checagem, segunda passada). Cada chamada da IA passa a gravar "gtm-1" junto da versão do prompt.

**Files:**
- Modify: `src/lib/ai/prompts/questions.ts`, `plan.ts`, `discover.ts`, `collect.ts`, `verify.ts`, `second-pass.ts`
- Test: `tests/unit/gtm-skills-inject.test.ts`

**Interfaces:**
- Consumes: `skillBlock`, `GTM_VERSION` (Task 5); `TASK_DEFS` (`src/lib/ai/tasks.ts`).
- Produces: in each file `SYSTEM` = job text + `\n\n${skillBlock(<step>)}\n\n` + the existing `WEB_RULES`/`HONESTY`/`UNTRUSTED` (safety rules stay last); `PROMPT_VERSION = "<name>-2026-11-<DD>.<n>+" + GTM_VERSION` (new date/n, e.g. `collect-2026-11-18.1+gtm-1`).

- [ ] **Step 1: Failing tests:** for each of `TASK_DEFS` (questions, plan, discover, collect, verify, second): `system` contains `skillBlock(step)`; `system.indexOf(skillBlock) < system.indexOf("Security rules")`; `promptVersion.endsWith("+" + GTM_VERSION)`; `promptVersion.length <= 40`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npm test` (whole suite; `ai-gateway`/`economy-mode` reservation tests must still pass with the longer system) + `npm run typecheck`. **Step 5: Commit** `feat(research): load GTM skills by stage`.

### Task 7: ORCHESTRATOR — eval with skills, ship or hold (needs Juan's ok)
**Para o Juan:** a mesma prova da Tarefa 4, agora com os manuais. Só vai para o ar se a nota subir. Gasto máximo US$ 8.

- [ ] Ask Juan for the US$ 8 cap; run the Task 4 command with `EVAL_BASELINE=<Task 4 JSON>`.
- [ ] `ship` → keep Tasks 5–6 for deploy (Task 10). `hold` → report the lines; revert Task 6 commit (skills stay in the repo unused) and propose one text change to Juan; each retry is a new US$ cap ask.

### Task 8: "Rápido / Caprichado" (D7)
**Para o Juan:** na tela de pesquisa e no criador de agente, duas escolhas em vez de três: Rápido (= Cuidadosa de hoje) e Caprichado (= Rigorosa: mais tempo, modelo maior, lead mais caro), com o teto de custo e tempo escrito.

**Files:**
- Modify: `src/lib/research/types.ts` (add `PICKABLE_RIGORS`), `src/components/research/PlanCard.tsx`, `src/components/agents/HunterReviewCard.tsx` (map `PICKABLE_RIGORS` instead of `RIGORS`; hint = `rigorHelp[rigor]` with `{cost}`/`{minutes}`/`{n}` replaced from `DEFAULT_CAPS[rigor]`, like `limitValue.replace`)
- Modify: `src/messages/pt/research.ts`, `src/messages/en/research.ts`
- Test: `tests/unit/rigor-modes.test.ts` (values + source-text checks like other component tests)

**Interfaces:**
- Produces: `export const PICKABLE_RIGORS = ["careful", "strict"] as const satisfies readonly Rigor[];` `quick` stays valid (old runs/agents, server zod enums unchanged).
- Copy (exact): pt `rigorNames: { quick: "Básica (antiga)", careful: "Rápido", strict: "Caprichado" }`; `rigorHelp.careful`: "Confere se a empresa existe e se tem obra agora. Até US$ {cost} e {minutes} min por busca, até {n} empresas."; `rigorHelp.strict`: "Tudo do Rápido, mais perfil e quem decide, com duas fontes, e outra IA tenta derrubar cada empresa. Lead mais caro: até US$ {cost} e {minutes} min por busca, até {n} empresas."; `rigorHelp.quick` unchanged. en: "Basic (old)", "Fast", "Thorough"; same sentences in English.

- [ ] **Step 1: Failing tests:** `PICKABLE_RIGORS` equals `["careful","strict"]`; pt/en names as above; with `DEFAULT_CAPS.strict` the filled pt help contains `US$ 5`, `60 min`, `25 empresas`; `PlanCard.tsx` and `HunterReviewCard.tsx` sources contain `PICKABLE_RIGORS.map` and not `RIGORS.map`; no "LinkedIn" in pt/en `research.ts`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx vitest run tests/unit` + `npm run typecheck` PASS. **Step 5: Commit** `feat(research): Rápido / Caprichado picker`.

### Task 9: Outreach skills into e-mail and qualifier prompts — BLOCKED on Juan
**Para o Juan:** ligar cadência, objeções e gancho nos textos de e-mail, no resumo da closer e no Qualificador. A régua de hoje não mede e-mail, então pela regra 11.2 isso só entra se você liberar.

**Files:** Modify `src/lib/ai/prompts/email-sequence.ts`, `email.ts` (DRAFT, REPLY, BRIEF), `qualify-light.ts`; Test: extend `tests/unit/gtm-skills-inject.test.ts`.
- [ ] Same pattern and tests as Task 6 for steps `email_sequence`, `email_draft`, `email_reply`, `closer_brief`, `qualify_light` (system contains block before the safety text; version `+gtm-1`, `<= 40` chars); `npm test`. Commit `feat(ai): GTM skills in outreach prompts`.

### Task 10: ORCHESTRATOR — deploy
- [ ] `npm run check` in `app/`; push `main` (Tasks 1–3, 5–8, and 6 only if Task 7 said `ship`). No DB change.
- [ ] Browser check: new research and agent wizard show "Rápido / Caprichado" with the cost line; phone width 375 px.
- [ ] Prod check: after the next Caçador run, `select distinct prompt_version from ai_calls where run_id = <id>` shows `+gtm-1`.

## Open items ("?")
- Ship gate weights and margins (quality = hits + 2·hot + 2·decisor; margin +2; proof −0.05; cost +25%) — Claude — conferir.
- D7 mapping Rápido = `careful`, Caprichado = `strict` (alternative: Rápido = `quick`, cheaper but no "tem obra" check, so no hook) — Claude — conferir.
- Town spelling variants in the gold sheet for each case (`goldCities`) — the implementer checks counts locally; never commit them beyond town names.
- One run per pair is noisy; repeat runs per pair would cost more — Juan decides if the cap allows 2 runs.
- What "bater o ouro" means as a number (e.g. ≥ 80% of the town's hot rows) — reported, not gated, until Juan sets it.
