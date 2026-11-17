"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { countLeadsAction, createEmailAgentAction } from "@/app/(app)/agentes/novo/email/actions";
import { StepSet } from "@/components/research/controls";
import { Badge, Chevron, Field, HexButton, HexPanel, Notice, Select, TextInput } from "@/components/ui";
import { MAX_MAILBOXES, PICKABLE_STATUSES, TONES, type LeadCounts, type LeadFilterConfig, type Tone } from "@/lib/email-agent/types";
import type { LeadStatus } from "@/lib/leads/types";
import { TEMPERATURES } from "@/lib/research/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

type Mailbox = { id: string; email: string; status: string };

/** The 5 questions of the E-mail agent (spec §6.3). Controlled: values stay after an error. The AI writes only on the final click. */
export function EmailAgentWizard({ mailboxes, hunters, ai, estimateUsd }: { mailboxes: Mailbox[]; hunters: { id: string; name: string }[]; ai: boolean; estimateUsd: number }) {
  const t = useT();
  const E = t.emailAgent;
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

  const hint = "m-0 text-base text-[#4a5361]";
  const mono = "font-mono text-[13px] font-medium uppercase tracking-wide text-ink";
  const chip = "k-btn inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-line bg-surface px-4 text-[15px] has-[:checked]:border-honey has-[:checked]:bg-honey-light has-[:checked]:font-semibold has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";
  const box = "size-[18px] accent-ink";
  return (
    <HexPanel wrapClassName="k-in" className="py-7">
    <form onSubmit={submit} aria-label={t.agents.types.email} className="flex flex-col gap-7">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl">{E.title}</h2>
        <p className={hint}>{E.intro}</p>
      </div>

      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-7 border-0 p-0">
      <Field label={E.name} htmlFor="email-agent-name">
        <TextInput id="email-agent-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>

      <StepSet n={1} title={E.qLeads}>
        <div role="group" aria-label={E.statuses} className="flex flex-col gap-2">
          <span className={mono}>{E.statuses}</span>
          <div className="flex flex-wrap gap-2">
            {PICKABLE_STATUSES.map((s) => (
              <label key={s} className={chip}>
                <input type="checkbox" className={box} checked={statuses.includes(s)} onChange={() => setStatuses((cur) => toggle(cur, s))} />
                {t.leads.statuses[s]}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={E.agent} htmlFor="email-agent-source">
            <Select id="email-agent-source" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">{E.anyAgent}</option>
              {hunters.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={E.temperature} htmlFor="email-agent-temperature">
            <Select id="email-agent-temperature" value={temperature} onChange={(e) => setTemperature(e.target.value)}>
              <option value="">{E.anyTemperature}</option>
              {TEMPERATURES.map((x) => (
                <option key={x} value={x}>
                  {t.research.labels.temperatureTitle[x]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className={`${chip} self-start`}>
          <input type="checkbox" className={box} checked={onlyEmail} onChange={(e) => setOnlyEmail(e.target.checked)} />
          {E.onlyEmailApproach}
        </label>
        <p role="status" className="m-0 rounded-[14px] bg-honey-soft px-4 py-3 text-base">
          {countError ? (
            <span className="text-warn">{countError}</span>
          ) : counts ? (
            <>
              {fill(E.counts, { total: counts.total, withEmail: counts.withEmail, withoutEmail: counts.withoutEmail })}
              {counts.total >= 500 && <span className="block text-[15px] text-[#4a5361]">{E.countsMax}</span>}
            </>
          ) : statuses.length > 0 ? (
            E.counting
          ) : null}
        </p>
      </StepSet>

      <StepSet n={2} title={E.qTone}>
        <div className="flex flex-wrap gap-2">
          {TONES.map((x) => (
            <label key={x} className={chip}>
              <input type="radio" name="tone" className={box} checked={tone === x} onChange={() => setTone(x)} />
              {E.tones[x]}
            </label>
          ))}
        </div>
      </StepSet>

      <StepSet n={3} title={E.qSteps}>
        <div role="group" aria-label={E.steps} className="flex flex-col gap-2">
          <span className={mono}>{E.steps}</span>
          <div className="flex flex-wrap gap-2">
            {([1, 2, 3] as const).map((n) => (
              <label key={n} className={`${chip} min-w-16 justify-center`}>
                <input type="radio" name="steps" className={box} checked={steps === n} onChange={() => setSteps(n)} />
                {n}
              </label>
            ))}
          </div>
        </div>
        {steps >= 2 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={E.step2} htmlFor="email-agent-step2">
              <TextInput id="email-agent-step2" type="number" inputMode="numeric" min={1} max={30} value={step2} onChange={(e) => setStep2(e.target.value)} aria-invalid={!delaysOk} />
            </Field>
            {steps === 3 && (
              <Field label={E.step3} htmlFor="email-agent-step3">
                <TextInput id="email-agent-step3" type="number" inputMode="numeric" min={2} max={60} value={step3} onChange={(e) => setStep3(e.target.value)} aria-invalid={!delaysOk} />
              </Field>
            )}
          </div>
        )}
        {steps >= 2 && <p className={hint}>{E.delaysHint}</p>}
      </StepSet>

      <StepSet n={4} title={E.qMailboxes} hint={E.mailboxesHint}>
        {mailboxes.length === 0 ? (
          <Notice tone="warn">{E.noMailboxes}</Notice>
        ) : (
          <div className="flex flex-wrap gap-2">
            {mailboxes.map((m) => {
              const usable = m.status === "ok";
              const on = picked.includes(m.id);
              return (
                <label key={m.id} className={chip}>
                  <input type="checkbox" className={box} checked={on} disabled={!usable || (!on && picked.length >= MAX_MAILBOXES)} onChange={() => setPicked((cur) => toggle(cur, m.id))} />
                  {m.email}
                  {!usable && <Badge tone="neutral" className="py-0 text-[13px]">{E.unverified}</Badge>}
                </label>
              );
            })}
          </div>
        )}
      </StepSet>

      <StepSet n={5} title={E.qReview}>
        <div className="flex flex-col gap-1.5 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3">
          <p className="m-0 text-base font-semibold">
            {fill(E.review, { leads: counts?.withEmail ?? 0, tone: E.tones[tone].toLowerCase(), steps, boxes: picked.length })}
          </p>
          <p className="m-0 text-[15px] text-[#4a5361]">{ai ? fill(E.estimate, { usd: estimateUsd.toFixed(2) }) : E.noAi}</p>
        </div>
        {counts && counts.withEmail === 0 && <Notice tone="warn">{E.noLeads}</Notice>}
      </StepSet>

      </fieldset>

      {error && (
        <Notice tone="warn" role="alert">
          {error.message}{" "}
          {error.agentId && (
            <Link href={`/agentes/${error.agentId}`} className="font-medium underline underline-offset-4">
              {E.openAgent}
            </Link>
          )}
          {locked && <span className="block">{E.retryLocked}</span>}
        </Notice>
      )}
      <div>
        <HexButton type="submit" disabled={pending || !ready}>
          {pending ? E.creating : locked ? E.retry : E.create} <Chevron className="k-arrow" />
        </HexButton>
      </div>
    </form>
    </HexPanel>
  );
}
