# F5 Task 7 report: Funil, README, listSize, full check
Files new: app/src/lib/leads/funnel.ts, app/src/app/(app)/leads/funil/page.tsx (requireSender), app/tests/unit/funnel.test.ts (red first: import failed).
Modified: app/README.md (F5 section: deploy order 0016->0020 before app, roles, invite flow, hand-off, call agent, list rules, tela de ligação, outcomes->status, do_not_call + F4 gate duty, Funil), AgentList.tsx (listSizes prop -> agentRowView listSize), agentes/page.tsx, lib/calls/list-queries.ts (listSizesToday).
messages/pt/funnel.ts untouched: calls-view.test asserts exact keys; headers reuse t.leads.statuses.
Check (npm run check, with the other agent's uncommitted 0019 files present): typecheck 0, lint 0 errors/4 warnings (pre-existing), 83 files 1371 passed 3 todo, build OK (routes incl. /configuracoes/equipe, /convite/[token], /leads/ligar, /leads/ligar/[id], /leads/funil), check-client-bundle ok. No clean-worktree run needed (no failures).
