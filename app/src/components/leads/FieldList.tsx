"use client";

import { date, host } from "@/components/research/format";
import { EmailBadge } from "@/components/leads/EmailBadge";
import type { EmailQuality } from "@/lib/leads/email-quality";
import type { LeadFieldRow } from "@/lib/leads/types";
import { sanitizeUrl } from "@/lib/safe-url";
import { useT } from "@/lib/i18n/client";

/** Every value of a lead with where it came from. Values are text only (a "=HYPERLINK" cell is just text here). */
export function FieldList({ fields, importNames, emailQuality = {} }: { fields: LeadFieldRow[]; importNames: Record<string, string>; emailQuality?: Record<string, EmailQuality> }) {
  const t = useT();
  const L = t.leads;
  if (fields.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col rounded-[14px] border border-[#e3e6ec] p-0">
      {fields.map((f) => {
        const link = f.source !== "import" ? sanitizeUrl(f.source_ref) : null;
        const source = f.source === "import" && f.source_ref ? (importNames[f.source_ref] ?? L.sources.import) : L.sources[f.source];
        const refuted = f.status === "refuted";
        return (
          <li key={f.id} className="k-row flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#eef0f3] px-4 py-3 text-[15px] last:border-b-0">
            <span className="w-32 shrink-0 font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{L.fieldLabels[f.field]}</span>
            <span className={`min-w-0 flex-1 break-words text-base ${refuted ? "line-through text-[#4a5361]" : "font-medium"}`}>
              {f.value}
              {f.field === "email" && (
                <span className="ml-2">
                  <EmailBadge quality={emailQuality[f.value.trim().toLowerCase()] ?? (f.source === "pattern" ? "unknown" : null)} />
                </span>
              )}
            </span>
            <span className="text-[#4a5361]">
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer" className="k-link underline">
                  {host(link)}
                </a>
              ) : (
                source
              )}{" "}
              · {date(f.seen_at, t.intl)}
            </span>
            {f.status === "confirmed" && <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-sm font-medium text-ok" title={L.confirmed}>✓ {L.confirmed}</span>}
            {f.status === "unverified" && <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-sm font-medium text-warn">⚠ {L.unproven}</span>}
          </li>
        );
      })}
    </ul>
  );
}
