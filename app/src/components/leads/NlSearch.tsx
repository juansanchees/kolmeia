"use client";

import { useEffect, useRef, useState } from "react";
import { btn } from "@/components/email/bits";
import { isEmptyNl, parseLeadQuery, type NlFilters } from "@/lib/leads/nl-search";
import { fill, t } from "@/messages/pt";

const N = t.leads.nlSearch;
const RULES_MS = 200;
const AI_MS = 800;

/** The chips of the detected filters, in the order the panel shows them. */
export function nlChips(f: NlFilters): string[] {
  const c = N.chips;
  return [
    ...(f.cities ?? []).map((v) => fill(c.city, { v })),
    ...(f.companyTypes ?? []).map((v) => fill(c.type, { v: N.types[v] })),
    ...(f.temperature && f.temperature !== "all" && f.temperature !== "none" ? [fill(c.temperature, { v: t.research.labels.temperature[f.temperature] })] : []),
    ...(f.levels ?? []).map((v) => fill(c.level, { v })),
    ...(f.minLevel ? [fill(c.minLevel, { v: f.minLevel })] : []),
    ...(f.hasPhone ? [c.phone] : []),
    ...(f.hasEmail ? [c.email] : []),
    ...(f.emailQuality ?? []).map((v) => fill(c.emailQuality, { v: t.leads.emailQuality.labels[v] })),
    ...(f.contact && f.contact !== "all" ? [fill(c.contact, { v: t.leads.contactTabs[f.contact] })] : []),
  ];
}

/**
 * "Descreva quem você quer": local rules after 200 ms, then (only when words were left over) the AI after 800 ms,
 * which replaces the rules' result. Each keystroke aborts the previous AI request. Nothing is applied until
 * "Aplicar filtros".
 */
export function NlSearch({ cities, onApply }: { cities: string[]; onApply: (f: NlFilters) => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<NlFilters | null>(null);
  const [thinking, setThinking] = useState(false);
  const [aiOff, setAiOff] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    abort.current?.abort();
    const q = text.trim();
    if (!q) return; // an empty box shows nothing (see `active`)
    let unparsed: string[] = [];
    const rules = setTimeout(() => {
      const r = parseLeadQuery(q, cities);
      unparsed = r.unparsed;
      setFound(r.filters);
      setAiOff(false);
      setThinking(r.unparsed.length > 0); // the AI layer will run: do not say "nothing found" yet
    }, RULES_MS);
    const ai = setTimeout(async () => {
      if (unparsed.length === 0) return;
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const res = await fetch("/api/leads/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: q, cities: cities.slice(0, 300) }), signal: ctl.signal });
        const j = (await res.json()) as { filters?: NlFilters; error?: string };
        if (ctl.signal.aborted) return;
        if (j.filters && !isEmptyNl(j.filters)) setFound(j.filters);
        else if (j.error) setAiOff(true);
      } catch {
        if (!ctl.signal.aborted) setAiOff(true);
      } finally {
        if (!ctl.signal.aborted) setThinking(false);
      }
    }, AI_MS);
    return () => {
      clearTimeout(rules);
      clearTimeout(ai);
    };
  }, [text, cities]);

  const active = text.trim() !== "";
  const chips = active && found ? nlChips(found) : [];
  const settled = active && found !== null && !thinking;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{N.label}</span>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={N.placeholder}
          maxLength={200}
          className="min-h-11 min-w-0 border border-line bg-surface px-3 text-sm text-ink"
        />
      </label>
      <div aria-live="polite" className="flex flex-col gap-2">
        {active && thinking && <p className="text-[13px] text-muted">{N.thinking}</p>}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted">{N.detected}</span>
            {chips.map((c) => (
              <span key={c} className="border border-blue bg-blue-wash px-2 py-0.5 text-[13px] text-blue-ink">
                {c}
              </span>
            ))}
            <button type="button" onClick={() => found && onApply(found)} className={btn.primary}>
              {N.apply}
            </button>
          </div>
        )}
        {settled && chips.length > 0 && aiOff && <p className="text-[13px] text-muted">{N.aiOff}</p>}
        {settled && chips.length === 0 && <p className="text-[13px] text-muted">{N.nothing}</p>}
      </div>
    </div>
  );
}
