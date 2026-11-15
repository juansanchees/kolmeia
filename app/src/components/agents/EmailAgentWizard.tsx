"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { countLeadsAction, createEmailAgentAction } from "@/app/(app)/agentes/novo/email/actions";
import { input } from "@/components/email/bits";
import { PrimaryButton } from "@/components/research/controls";
import { MAX_MAILBOXES, PICKABLE_STATUSES, TONES, type LeadCounts, type LeadFilterConfig, type Tone } from "@/lib/email-agent/types";
import type { LeadStatus } from "@/lib/leads/types";
import { TEMPERATURES } from "@/lib/research/types";
import { fill, t } from "@/messages/pt";

const E = t.emailAgent;

type Mailbox = { id: string; email: string; status: string };

/** The 5 questions of the E-mail agent (spec §6.3). Controlled: values stay after an error. The AI writes only on the final click. */
export function EmailAgentWizard({ mailboxes, hunters, ai, estimateUsd }: { mailboxes: Mailbox[]; hunters: { id: string; name: string }[]; ai: boolean; estimateUsd: number }) {
  const router = useRouter();
  const [name, setName] = useState<string>(E.defaultName);
  const [statuses, setStatuses] = useState<LeadStatus[]>(["new"]);
  const [agentId, setAgentId] = useState("");
  const [temperature, setTemperature] = useState("");
  const [onlyEmail, setOnlyEmail] = useState(false);
  const [tone, setTone] = useState<Tone>("direct");
  const [steps, setSteps] = useState<1 | 2 | 3>(3);
  const [step2, setStep2] = useState("3");
  const [step3, setStep3] = useState("7");
  const [picked, setPicked] = useState<string[]>([]);
  const [answer, setAnswer] = useState<{ key: string; counts?: LeadCounts; error?: string } | null>(null);
  const [error, setError] = useState<{ message: string; agentId?: string; draft?: Parameters<typeof createEmailAgentAction>[3] } | null>(null);
  // after an AI failure the agent already exists with these choices: a retry reuses them, so the form is read only
  const locked = Boolean(error?.agentId);
  const [pending, start] = useTransition();

  const filter: LeadFilterConfig = { statuses, agentId: agentId || null, temperature: temperature || null, approach: onlyEmail ? "email" : null };
  const filterKey = JSON.stringify(filter);

  // live counts: a read only, never the AI. The answer carries the filter it was asked for, so a stale one is ignored.
  useEffect(() => {
    if (statuses.length === 0) return;
    let stale = false;
    const timer = setTimeout(() => {
      countLeadsAction(JSON.parse(filterKey) as LeadFilterConfig).then((r) => {
        if (!stale) setAnswer(r.ok ? { key: filterKey, counts: r.counts } : { key: filterKey, error: r.error });
      });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [filterKey, statuses.length]);
  const fresh = answer?.key === filterKey ? answer : null;
  const counts = fresh?.counts ?? null;
  const countError = fresh?.error ?? null;

  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const d2 = Number(step2);
  const d3 = Number(step3);
  const delaysOk = steps === 1 || (Number.isInteger(d2) && d2 >= 1 && d2 <= 30 && (steps === 2 || (Number.isInteger(d3) && d3 > d2 && d3 <= 60)));
  const ready = ai && name.trim().length > 0 && statuses.length > 0 && picked.length >= 1 && picked.length <= MAX_MAILBOXES && delaysOk && (counts?.withEmail ?? 0) > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    start(async () => {
      setError(null);
      // the AI is asked here and nowhere else
      const r = await createEmailAgentAction(
        { filter, tone, steps, delays: { step2: steps === 1 ? 3 : d2, step3: steps === 3 ? d3 : Math.max(d2 + 1, 7) }, mailboxIds: picked },
        name,
        error?.agentId ?? null,
        error?.draft ?? null,
      );
      if (r.ok) router.push(`/agentes/${r.agentId}`);
      else setError({ message: r.error, agentId: r.agentId, draft: r.draft });
    });
  };

  const q = "text-base font-semibold";
  const hint = "text-[13px] text-muted";
  return (
    <form onSubmit={submit} aria-label={t.agents.types.email} className="flex flex-col gap-5 border border-line bg-surface p-5">
      <div>
        <h2 className="text-2xl">{E.title}</h2>
        <p className="mt-1 text-sm text-muted">{E.intro}</p>
      </div>

      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-mono text-xs text-muted">{E.name}</span>
        <input className={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className={`${q} mb-1`}>{E.qLeads}</legend>
        <div role="group" aria-label={E.statuses} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="font-mono text-xs text-muted">{E.statuses}</span>
          {PICKABLE_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input type="checkbox" checked={statuses.includes(s)} onChange={() => setStatuses((cur) => toggle(cur, s))} />
              {t.leads.statuses[s]}
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-mono text-xs text-muted">{E.agent}</span>
          <select className={input} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">{E.anyAgent}</option>
            {hunters.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-mono text-xs text-muted">{E.temperature}</span>
          <select className={input} value={temperature} onChange={(e) => setTemperature(e.target.value)}>
            <option value="">{E.anyTemperature}</option>
            {TEMPERATURES.map((x) => (
              <option key={x} value={x}>
                {t.research.labels.temperatureTitle[x]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyEmail} onChange={(e) => setOnlyEmail(e.target.checked)} />
          {E.onlyEmailApproach}
        </label>
        <p role="status" className="text-sm">
          {countError ? (
            <span className="text-warn">{countError}</span>
          ) : counts ? (
            <>
              {fill(E.counts, { total: counts.total, withEmail: counts.withEmail, withoutEmail: counts.withoutEmail })}
              {counts.total >= 500 && <span className={`${hint} block`}>{E.countsMax}</span>}
            </>
          ) : statuses.length > 0 ? (
            E.counting
          ) : null}
        </p>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className={`${q} mb-1`}>{E.qTone}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {TONES.map((x) => (
            <label key={x} className="flex items-center gap-2">
              <input type="radio" name="tone" checked={tone === x} onChange={() => setTone(x)} />
              {E.tones[x]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className={`${q} mb-1`}>{E.qSteps}</legend>
        <div role="group" aria-label={E.steps} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="font-mono text-xs text-muted">{E.steps}</span>
          {([1, 2, 3] as const).map((n) => (
            <label key={n} className="flex items-center gap-2">
              <input type="radio" name="steps" checked={steps === n} onChange={() => setSteps(n)} />
              {n}
            </label>
          ))}
        </div>
        {steps >= 2 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-mono text-xs text-muted">{E.step2}</span>
            <input className={input} type="number" inputMode="numeric" min={1} max={30} value={step2} onChange={(e) => setStep2(e.target.value)} aria-invalid={!delaysOk} />
          </label>
        )}
        {steps === 3 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-mono text-xs text-muted">{E.step3}</span>
            <input className={input} type="number" inputMode="numeric" min={2} max={60} value={step3} onChange={(e) => setStep3(e.target.value)} aria-invalid={!delaysOk} />
          </label>
        )}
        {steps >= 2 && <span className={hint}>{E.delaysHint}</span>}
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className={`${q} mb-1`}>{E.qMailboxes}</legend>
        {mailboxes.length === 0 ? (
          <p className="text-sm text-warn">{E.noMailboxes}</p>
        ) : (
          mailboxes.map((m) => {
            const usable = m.status === "ok";
            const on = picked.includes(m.id);
            return (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={on} disabled={!usable || (!on && picked.length >= MAX_MAILBOXES)} onChange={() => setPicked((cur) => toggle(cur, m.id))} />
                {m.email}
                {!usable && <span className="font-mono text-xs text-muted">{E.unverified}</span>}
              </label>
            );
          })
        )}
        <span className={hint}>{E.mailboxesHint}</span>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className={`${q} mb-1`}>{E.qReview}</legend>
        <p className="text-sm">
          {fill(E.review, { leads: counts?.withEmail ?? 0, tone: E.tones[tone].toLowerCase(), steps, boxes: picked.length })}
        </p>
        <p className="text-sm text-muted">{ai ? fill(E.estimate, { usd: estimateUsd.toFixed(2) }) : E.noAi}</p>
        {counts && counts.withEmail === 0 && <p className="text-sm text-warn">{E.noLeads}</p>}
      </fieldset>

      </fieldset>

      {error && (
        <p role="alert" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          {error.message}{" "}
          {error.agentId && (
            <Link href={`/agentes/${error.agentId}`} className="underline underline-offset-4">
              {E.openAgent}
            </Link>
          )}
          {locked && <span className="block">{E.retryLocked}</span>}
        </p>
      )}
      <div>
        <PrimaryButton type="submit" disabled={pending || !ready}>
          {pending ? E.creating : locked ? E.retry : E.create}
        </PrimaryButton>
      </div>
    </form>
  );
}
