"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createCallAgentAction } from "@/app/(app)/agentes/call-actions";
import { StepSet } from "@/components/research/controls";
import { Chevron, Field, HexButton, HexPanel, Notice, Select, TextInput } from "@/components/ui";
import type { Person } from "@/lib/team/types";
import { TEMPERATURES, type Temperature } from "@/lib/research/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/** The 3 questions of the Ligação agent (spec §6.3): which leads, how many a day, who calls. Controlled: values stay after an error. */
export function CallAgentForm({ people }: { people: Person[] }) {
  const t = useT();
  const C = t.callAgent;
  const router = useRouter();
  const [name, setName] = useState<string>(C.defaultName);
  const [minLevel, setMinLevel] = useState(1);
  const [temps, setTemps] = useState<Temperature[]>([]);
  const [perDay, setPerDay] = useState("20");
  const [caller, setCaller] = useState(people[0]?.user_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (x: Temperature) => setTemps((cur) => (cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x]));
  const n = Number(perDay);
  const perDayOk = Number.isInteger(n) && n >= 1 && n <= 50;
  const ready = name.trim().length > 0 && perDayOk && caller !== "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    start(async () => {
      setError(null);
      const r = await createCallAgentAction({ name, config: { caller_id: caller, per_day: n, min_level: minLevel, temperatures: temps } });
      if (r.ok) router.push(`/agentes/${r.agentId}`);
      else setError(r.error);
    });
  };

  const check = "k-btn inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-line bg-surface px-4 text-[15px] has-[:checked]:border-honey has-[:checked]:bg-honey-light has-[:checked]:font-semibold";
  return (
    <HexPanel wrapClassName="k-in" className="py-7">
    <form onSubmit={submit} aria-label={t.agents.types.call} className="flex flex-col gap-7">
      <Field label={C.name} htmlFor="call-name">
        <TextInput id="call-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>

      <StepSet n={1} title={C.qFilter}>
        <Field label={C.minLevel} htmlFor="call-min-level">
          <Select id="call-min-level" value={minLevel} onChange={(e) => setMinLevel(Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((l) => (
              <option key={l} value={l}>
                {fill(C.levelOption, { n: l })}
              </option>
            ))}
          </Select>
        </Field>
        <div role="group" aria-label={C.temperatures} className="flex flex-col gap-2">
          <span className="font-mono text-[13px] font-medium uppercase tracking-wide text-ink">{C.temperatures}</span>
          <div className="flex flex-wrap gap-2">
            <label className={check}>
              <input type="checkbox" className="size-[18px] accent-ink" checked={temps.length === 0} onChange={() => setTemps([])} />
              {C.any}
            </label>
            {TEMPERATURES.map((x) => (
              <label key={x} className={check}>
                <input type="checkbox" className="size-[18px] accent-ink" checked={temps.includes(x)} onChange={() => toggle(x)} />
                {t.research.labels.temperatureTitle[x]}
              </label>
            ))}
          </div>
        </div>
      </StepSet>

      <StepSet n={2} title={C.qPerDay}>
        <TextInput
          aria-label={C.qPerDay}
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          value={perDay}
          onChange={(e) => setPerDay(e.target.value)}
          aria-invalid={!perDayOk}
          aria-describedby="per-day-hint"
          className="max-w-40"
        />
        <span id="per-day-hint" className="text-base text-[#4a5361]">
          {C.perDayHint}
        </span>
      </StepSet>

      <StepSet n={3} title={C.qCaller}>
        {people.length === 0 ? (
          <Notice tone="warn">{C.noPeople}</Notice>
        ) : (
          <Select aria-label={C.qCaller} value={caller} onChange={(e) => setCaller(e.target.value)}>
            {people.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.label} · {t.team.roles[p.role]}
              </option>
            ))}
          </Select>
        )}
      </StepSet>

      {error && (
        <Notice tone="warn" role="alert">
          {error}
        </Notice>
      )}
      <div>
        <HexButton type="submit" disabled={pending || !ready}>
          {C.create} <Chevron className="k-arrow" />
        </HexButton>
      </div>
    </form>
    </HexPanel>
  );
}
