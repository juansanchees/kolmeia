import { date, host } from "@/components/research/format";
import type { LeadFieldRow } from "@/lib/leads/types";
import { sanitizeUrl } from "@/lib/safe-url";
import { t } from "@/messages/pt";

const L = t.leads;

/** Every value of a lead with where it came from. Values are text only (a "=HYPERLINK" cell is just text here). */
export function FieldList({ fields, importNames }: { fields: LeadFieldRow[]; importNames: Record<string, string> }) {
  if (fields.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col border border-line p-0">
      {fields.map((f) => {
        const link = f.source !== "import" ? sanitizeUrl(f.source_ref) : null;
        const source = f.source === "import" && f.source_ref ? (importNames[f.source_ref] ?? L.sources.import) : L.sources[f.source];
        const refuted = f.status === "refuted";
        return (
          <li key={f.id} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line px-3 py-2 text-[13px] last:border-b-0">
            <span className="w-28 shrink-0 font-mono text-xs text-muted">{L.fieldLabels[f.field]}</span>
            <span className={`min-w-0 flex-1 break-words text-sm ${refuted ? "line-through text-muted" : ""}`}>{f.value}</span>
            <span className="text-muted">
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                  {host(link)}
                </a>
              ) : (
                source
              )}{" "}
              · {date(f.seen_at)}
            </span>
            {f.status === "unverified" && <span className="font-mono text-xs text-muted">⚠ {L.unproven}</span>}
          </li>
        );
      })}
    </ul>
  );
}
