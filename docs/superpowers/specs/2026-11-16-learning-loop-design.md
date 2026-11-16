# Learning loop (Caçador learns from results) — design (short)

Date: 2026-11-16. Owner: Juan (delegated all decisions: "sempre na simplicidade, design clean, que funcione").

## Why
The Caçador (hunter) only learns from imported lists (manual "Treinar" → approved profile → hints in the collect prompt). Lead outcomes (call results, replies, won/lost) are stored but never fed back. Juan wants the system to get better at finding the right companies over time, and the seller needs a dead-simple way to record what a company said.

## Goals
1. Seller records each contact in ~5 seconds from the lead modal.
2. Recording moves the lead's stage automatically (no separate status clicks).
3. Weekly, the system turns results into a proposed profile update; Juan approves; future Caçador searches use it (favor what worked, avoid what didn't).
4. /leads priority order gives a boost to leads that match the approved profile.

## Non-goals
Call recording/transcription (MA all-party consent), WhatsApp, numeric ML models/weights, auto-applying profile changes without approval, per-lead similarity scores beyond the existing profile match.

## Decisions (Claude's calls)
**Contact record (lead modal, sender-only, top of the actions area):** one row of 5 buttons + optional one-line note:
- Não atendeu → first_contacted_at set if empty, last_touch_at = now (stage Contatado).
- Quer reunião → status meeting.
- Ligar depois → date field (default +3 days) → creates a task for that date; stage Contatado.
- Sem interesse → status lost.
- Não ligar mais → status discarded + do_not_call.
- Second row (small links, modal and call screen): Caixa postal (voicemail) and Número errado (wrong_number: the lead leaves the call lists until a new phone appears, 0020 lead_callable). Recepção is recorded as Não atendeu.
- As built: Não ligar mais sets status **lost** + do_not_call (not discarded), because log_call (0020 lead_status_after_call) already maps do_not_call to lost; discarded stays a manual choice.
- A lead without a phone cannot record a contact yet (log_call needs a phone). Future: an e-mail / WhatsApp outcome.
- Results proposals carry over the approved profile's points (marked "do perfil aprovado", their own citations) unless the model lists them as contradicted; approving one supersedes the approved profile, so nothing is lost silently.
Every record is stored as a contact event (reuse the existing calls table / call logging if it already stores outcome + note; extend minimally otherwise) with outcome, note, author, time. History shows in the modal (existing CallHistory if reusable). Optional, never blocking.

**Outcome labels for learning:** positive = meeting, won, email reply classified interested (existing email_messages.ai_signal); negative = lost, discarded, Sem interesse; neutral (ignored) = Não atendeu, Ligar depois, Caixa postal, Número errado.

**Learning job:** reuse the existing profile machinery (trainProfileAction / approve_profile / profile_hints). New proposal source "results": one Sonnet call over a sample of up to 40 positive + 40 negative leads (type, city, company_type, size note, biggest job, origin list, contact notes) asking for: what the good ones have in common, what to avoid, towns/types to favor/avoid, up to 8 search queries. Saved as a profile proposal Juan approves on the existing profile page. Trigger: automatically at most once a week from the existing hunter tick when ≥ 10 labeled leads (≥ 3 positive) exist since the last proposal, plus a manual button "Aprender com os resultados" on the profile page with the cost estimate. Respects AI caps/ledger. Approved "avoid" points go into the collect prompt as hints (same "hint, never a rule" framing).

**Priority boost:** priorityOf gives a small boost (after phone and temperature) to leads with profile_match.

## Verification
Unit tests: outcome→status/stage mapping, labeling (positive/negative/neutral), proposal-trigger rule (weekly, thresholds), prompt builder (untrusted-data guard). PGlite test for any new SQL. Browser: record "Não atendeu" on a lead → stage Contatado; "Ligar depois" → task appears in Tarefas.
