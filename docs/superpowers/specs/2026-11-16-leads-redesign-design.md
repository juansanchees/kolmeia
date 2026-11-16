# Leads page redesign — design (short)

Date: 2026-11-16. Owner: Juan. Size: medium change (one page + one migration), short design doc.

## Why
Juan (SDR, ADHD) opens /leads and cannot tell what he is looking at. Five stacked filter layers (shortcuts, AI search box, 4 dropdowns, 5 research tabs, left facets). "Frio" leads vanish from research tabs with no explanation. Columns show "?" and "sem prova" for every imported lead. The page freezes while typing. He needs: see the stage of each lead, park leads he already worked (archive, never delete), split by company type (residential / small / large), and see/filter which list a lead came from.

## Goals
- One glance tells: company type, stage, has email/phone, origin list, last touch.
- Type tabs: Residencial / Pequena / Grande / Sem tipo, with counts.
- Stage tabs: Novo, Contatado, Respondeu, Reunião, Fechado, Arquivados, with counts.
- Archive / unarchive (single in lead modal, bulk in selection bar). Archived leads leave every view except "Arquivados"; nothing is deleted; history stays.
- Lead modal shows "Veio de: <list> (<date>)" for every list the lead is in; set/override type there.
- Filter by origin list.
- Page stops freezing at the current size (~1k leads, up to 5k).

## Non-goals
- Server-side filtering/pagination (approach B, rejected for now).
- Changing the other tabs (Com a closer, Ligar, Tarefas, Listas, Funil, Cobertura).
- Rebuilding AI search / AI column / qualifier logic (they move, not change).

## Anti-goals
- A lead disappearing with no visible reason. Every hidden set must have a tab or an active-filter chip with ×.
- Archive deleting or altering lead data, fields, history or list membership.

## Approaches (picked: A)
- **A. Rearrange + lighten (picked).** New layout; still loads leads to the browser, but slim props, memoized filters/counts, debounced search. Fixes freezing up to ~5k leads. ~1 day.
- B. Rearrange + server filters. DB filters and returns 15 rows. Scales to any size; ~2–3 days, higher risk of breaking existing filters. Upgrade path if base passes 5k.
- C. New page from scratch: rejected, throws away working filters, lists, modal.

## Decisions
**Layout (top to bottom)**
1. Type tabs: `Residencial · Pequena · Grande · Sem tipo · Todos` (counts).
2. Stage tabs: `Novo → Contatado → Respondeu → Reunião → Fechado | Arquivados` (counts).
3. One row: text search (empresa, cidade, telefone; debounced 200 ms) · `Filtros ▾` · `⋯`.
4. Active filter chips with × and "Limpar".
5. Table, 15/page (existing Pager).
6. Selection bar appears only when rows are selected: Adicionar à lista · Achar e-mail · Checar e-mails · Qualificar · Marcar tipo · Arquivar/Desarquivar.

**Filtros ▾** (panel): Cidade, Lista de origem, Tem e-mail, Tem telefone, Qualidade do e-mail, Nível, Temperatura (incl. "Sem pesquisa"), Agente.

**⋯ menu**: Subir lista, Buscar no Maps, Baixar CSV, Busca com IA ("Descreva quem você quer"), Pergunta da IA (column), Visões salvas, Qualificador (próximos N do filtro).

**Removed from the main screen**: shortcut buttons, Temperatura/Agente/Status/Nível dropdown row, research tabs (Ligar direto, Grandes, Empresas novas, Com sinal), Novos/Contatados/Todos tabs (replaced by stages), columns Temp./Abordagem/Prova. Temperature + approach + proof move into the lead modal.

**Columns**: Empresa (+ cidade) · Tipo · Contato (✉ ☎ icons, filled/empty) · Etapa · Origem (first list name) · Último contato.

**Type (segment)** — effective = manual override ?? derived:
- Grande: company_type in (developer, property_manager), or biggest permit ≥ US$ 500k, or approach = supplier_signup, or origin list name matches administradoras / incorporadoras / comercial / BERDO.
- Residencial: origin list name matches residencial / empreiteiros, or permits all residential and < US$ 500k.
- Pequena: manual only for now (no reliable data source).
- Sem tipo: everything else. Juan sets it in the modal or in bulk.
- Derivation lives in one pure TS function with a unit test.

**Stage** — derived from existing status + first_contacted_at, no new status:
- Novo: status new and no first_contacted_at.
- Contatado: call_list, in_campaign, or new with first_contacted_at.
- Respondeu: replied.
- Reunião: with_closer, meeting.
- Fechado: won, lost, discarded.
- Arquivados: archived_at not null (overrides the above).

**Data (migration 0030)**: `leads.archived_at timestamptz null`, `leads.segment text null check (segment in ('residential','small','large'))`. RLS unchanged (same row policies). Prod backup before applying.

**Origin**: from existing list membership (list_leads / import lists). Modal shows all lists with date; table shows the first one.

**Performance**: table props trimmed to the fields the table uses (full candidate stays in the modal, already loaded server-side via ?lead=); useMemo for filter, sort, facet counts and tab counts; one pass to compute all tab counts; no per-row `items.find`.

## Left to the builder
Exact component split, icons, copy details, how list names map to type keywords (configurable constant), test cases beyond the three pure functions (segment, stage, archive filter).

## Verification
Unit tests for segment/stage/archive. Typecheck + existing tests green. Browser check on kolmeia.solutions: counts add up to 966, archive → appears only in Arquivados → unarchive restores, origin filter works, typing in search does not freeze.
