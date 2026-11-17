"use client";

import { useState } from "react";
import { btn } from "@/components/email/bits";
import { t } from "@/messages/pt";

const A = t.home.ai;

/** "Quem você quer achar hoje?": a plain GET to LEADS, which opens its own "Busca com IA" with this text (?ia=). No AI flow of its own. */
export function AiBox() {
  const [text, setText] = useState("");
  return (
    <section aria-label={A.label} className="flex flex-col gap-2.5 border border-line bg-surface p-5">
      <form action="/leads" method="get" className="flex flex-col gap-2.5">
        <label htmlFor="home-ai" className="font-mono text-[13px] uppercase tracking-wide text-muted">
          {A.label}
        </label>
        <div className="flex flex-wrap gap-2.5">
          <input
            id="home-ai"
            name="ia"
            type="text"
            required
            maxLength={200}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={A.placeholder}
            className="min-h-13 min-w-0 flex-[999_1_320px] border border-edge bg-surface px-4 text-base text-ink"
          />
          <button type="submit" className={`${btn.primary} flex-[1_0_auto] px-6`}>
            {A.search}
          </button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2 text-sm">
        {A.presets.map((p) => (
          <button key={p} type="button" onClick={() => setText(p)} className="min-h-9 border border-line bg-ground px-3 text-sm text-ink hover:border-ink">
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}
