"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createCallAgentAction } from "@/app/(app)/agentes/call-actions";
import { PrimaryButton } from "@/components/research/controls";
import { input } from "@/components/email/bits";
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

  return (
    <form onSubmit={submit} aria-label={t.agents.types.call} className="flex flex-col gap-4 border border-line bg-surface p-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-mono text-xs text-muted">{C.name}</span>
        <input className={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-base font-semibold">{C.qFilter}</legend>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-mono text-xs text-muted">{C.minLevel}</span>
          <select className={input} value={minLevel} onChange={(e) => setMinLevel(Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((l) => (
              <option key={l} value={l}>
                {fill(C.levelOption, { n: l })}
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label={C.temperatures} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="font-mono text-xs text-muted">{C.temperatures}</span>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={temps.length === 0} onChange={() => setTemps([])} />
            {C.any}
          </label>
          {TEMPERATURES.map((x) => (
            <label key={x} className="flex items-center gap-2">
              <input type="checkbox" checked={temps.includes(x)} onChange={() => toggle(x)} />
              {t.research.labels.temperatureTitle[x]}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-base font-semibold">{C.qPerDay}</span>
        <input className={input} type="number" inputMode="numeric" min={1} max={50} value={perDay} onChange={(e) => setPerDay(e.target.value)} aria-invalid={!perDayOk} aria-describedby="per-day-hint" />
        <span id="per-day-hint" className="text-[13px] text-muted">
          {C.perDayHint}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-base font-semibold">{C.qCaller}</span>
        {people.length === 0 ? (
          <span className="text-warn">{C.noPeople}</span>
        ) : (
          <select className={input} value={caller} onChange={(e) => setCaller(e.target.value)}>
            {people.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.label} · {t.team.roles[p.role]}
              </option>
            ))}
          </select>
        )}
      </label>

      {error && (
        <p role="alert" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          {error}
        </p>
      )}
      <div>
        <PrimaryButton type="submit" disabled={pending || !ready}>
          {C.create}
        </PrimaryButton>
      </div>
    </form>
  );
}
