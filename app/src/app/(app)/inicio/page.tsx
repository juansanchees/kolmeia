import Link from "next/link";
import { AiBox } from "@/components/home/AiBox";
import { RuleEditor } from "@/components/home/RuleEditor";
import { SupabaseAgentStore } from "@/lib/agents/store";
import { homeEmail, loadHomeRule } from "@/lib/home/queries";
import { pickFirst, ruleInWords, type HomeRow } from "@/lib/home/rule";
import { dateLineOf, firstNameOf, funnelOf, greetingOf, parsePeriod, PERIODS, readyLine, todayCounts, topOrigins } from "@/lib/home/view";
import { stageOf } from "@/lib/leads/classify";
import { listLeads, originListsOf } from "@/lib/leads/queries";
import { toTableRow } from "@/lib/leads/table";
import { originKeyLabel, originKeysOf } from "@/lib/leads/view";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { openTasks } from "@/lib/tasks/queries";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const label = "!font-mono text-sm font-medium uppercase tracking-wide text-muted";
const ghost = "inline-flex min-h-12 items-center border border-edge bg-surface px-5 font-medium text-ink no-underline hover:border-ink";
const num = "font-display text-[44px] font-extrabold leading-none";
const day = (iso: string, intl: string) => new Date(iso).toLocaleDateString(intl, { timeZone: "America/New_York", day: "2-digit", month: "2-digit", hourCycle: "h23" });

function Has({ on, yes, no, children }: { on: boolean; yes: string; no: string; children: React.ReactNode }) {
  return (
    <span className={on ? "text-blue" : "text-muted opacity-40"}>
      <span aria-hidden className="inline-flex">{children}</span>
      <span className="sr-only">{on ? yes : no}</span>
    </span>
  );
}
const svg = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;

// Início: what to do today, read as the user (RLS: the closer only sees her own leads). One read of the leads feeds every number.
export default async function HomePage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const t = await getT();
  const H = t.home;
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  const user = await getUser();
  if (!supabase || !workspace || !user) return null;
  const sender = isSender(workspace.role);
  const period = parsePeriod((await searchParams).funil);
  const now = new Date();

  const [items, tasks, rule, agents, email] = await Promise.all([
    listLeads(supabase, workspace.id),
    openTasks(supabase, workspace.id),
    loadHomeRule(supabase, workspace.id, user.id),
    sender ? new SupabaseAgentStore(supabase).listAgents(workspace.id) : [],
    sender ? homeEmail(supabase, workspace.id) : null,
  ]);
  const origins = sender ? await originListsOf(supabase, items.map((i) => i.lead.id)) : new Map();
  const rows: HomeRow[] = items.map((i) => {
    const r = toTableRow(i, origins.get(i.lead.id) ?? []);
    return { ...r, lead: { ...r.lead, do_not_call: i.lead.do_not_call } };
  });

  const today = todayCounts(rows, tasks.map((x) => x.due_at), now);
  const funnel = funnelOf(rows, period, now, t);
  const picked = pickFirst(rows, rule);
  const topOrigin = topOrigins(rows);
  const maxOrigin = topOrigin[0]?.n ?? 1;
  // what the rule editor can pick from and count: only leads that could ever be on the list
  const candidates = rows.filter((r) => stageOf(r.lead) === "new" && !r.lead.do_not_call);
  const countBy = (keys: (r: HomeRow) => string[]) => {
    const m = new Map<string, number>();
    for (const r of candidates) for (const k of keys(r)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 100).map(([k]) => k);
  };
  const cities = countBy((r) => (r.display.city?.trim() ? [r.display.city.trim()] : []));
  const originNames = countBy((r) => originKeysOf(r));
  const slim = candidates.map((r) => ({ ...r, ai: undefined, best: r.best && ({ temperature: r.best.temperature, company_type: r.best.company_type, biggest_job_value_usd: r.best.biggest_job_value_usd } as typeof r.best) }));
  const found = new Map<string, number>();
  for (const i of items) if (i.lead.origin_agent_id) found.set(i.lead.origin_agent_id, (found.get(i.lead.origin_agent_id) ?? 0) + 1);
  const name = firstNameOf(user);
  const todayCards = [
    { ...H.today.ready, n: today.ready, href: "/leads/ligar" },
    { ...H.today.tasks, n: today.tasks, href: "/leads/tarefas" },
    { ...H.today.replied, n: today.replied, href: "/leads" },
    { ...H.today.meetings, n: today.meetings, href: "/leads" },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 font-mono text-[13px] tracking-wide text-muted">{dateLineOf(now, t)}</p>
          <h1 className="text-5xl font-extrabold uppercase leading-none">{name ? `${greetingOf(now, t)}, ${name}` : greetingOf(now, t)}</h1>
          <p className="mt-2.5 text-[17px] text-muted">{readyLine(today.ready, t)}</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {sender && <Link href="/leads/subir" className={ghost}>{H.upload}</Link>}
          <Link href="/leads/ligar" className="inline-flex min-h-12 items-center bg-ink px-5 font-semibold text-white no-underline hover:bg-blue">{H.startCalling}</Link>
        </div>
      </section>

      {sender && <AiBox />}

      <section aria-labelledby="hoje-t" className="flex flex-col gap-3">
        <h2 id="hoje-t" className={`${label}`}>{H.today.title}</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {todayCards.map((c) => (
            <Link key={c.label} href={c.href} className="flex min-h-[120px] flex-col gap-1.5 border border-line bg-surface p-5 text-ink no-underline hover:border-ink">
              <span className="text-[15px] text-muted">{c.label}</span>
              <span className={num}>{c.n.toLocaleString(t.intl)}</span>
              <span className="text-sm font-medium text-blue">{c.cta}</span>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="funil-t" className="flex flex-col gap-4 border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="funil-t" className={`${label}`}>{H.funnel.heading[period]}</h2>
          <nav aria-label={H.funnel.period} className="flex border border-edge text-sm">
            {PERIODS.map((p) => (
              <Link key={p} href={`/inicio?funil=${p}`} aria-current={p === period ? "true" : undefined} className={`inline-flex min-h-9 items-center px-3.5 no-underline ${p === period ? "bg-ink text-white" : "bg-surface text-ink hover:bg-ground"}`}>
                {H.funnel.periods[p]}
              </Link>
            ))}
          </nav>
        </div>
        <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] border-t border-line">
          {funnel.map((f) => (
            <div key={f.stage} className="flex flex-col gap-1.5 pb-1 pr-4 pt-4">
              <dt className="text-sm text-muted">{t.leads.stages[f.stage]}</dt>
              <dd className="m-0 flex flex-col gap-1.5">
                <span className="font-display text-4xl font-extrabold leading-none">{f.n.toLocaleString(t.intl)}</span>
                <span className="font-mono text-xs text-muted">{f.note}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="flex flex-wrap items-start gap-5">
        <section aria-labelledby="ligar-t" className="min-w-0 flex-[999_1_600px] border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id="ligar-t" className="text-[26px] font-extrabold uppercase">{H.first.title}</h2>
              <p className="mt-1 text-sm text-muted">{ruleInWords(rule, t)} {H.first.ruleTail}</p>
            </div>
            <div className="flex items-center gap-4">
              <RuleEditor rule={rule} rows={slim} cities={cities} origins={originNames} />
              <Link href="/leads" className="text-sm font-medium">{H.first.all}</Link>
            </div>
          </div>
          {picked.length === 0 ? (
            <p className="m-0 px-5 py-6 text-sm text-muted">{H.first.empty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-[15px]">
                <thead>
                  <tr className="text-left font-mono text-xs tracking-wide text-muted">
                    <th scope="col" className="px-5 py-3 font-medium">{H.first.cols.company}</th>
                    <th scope="col" className="px-2 py-3 font-medium">{H.first.cols.type}</th>
                    <th scope="col" className="px-2 py-3 font-medium">{H.first.cols.contact}</th>
                    <th scope="col" className="px-2 py-3 font-medium">{H.first.cols.origin}</th>
                    <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">{H.first.cols.action}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {picked.map((r) => (
                    <tr key={r.lead.id} className="border-t border-line">
                      <td className="px-5 py-3.5">
                        <Link href={`/leads?lead=${r.lead.id}`} className="font-semibold text-ink underline-offset-4 hover:underline">{r.display.name}</Link>
                        <div className="text-sm text-muted">{r.display.city?.trim() || H.first.noCity}</div>
                      </td>
                      <td className="px-2 py-3.5">{t.leads.segments[r.segment ?? "none"]}</td>
                      <td className="px-2 py-3.5">
                        <span className="inline-flex items-center gap-2">
                          <Has on={Boolean(r.display.email?.trim())} yes={H.first.hasEmail} no={H.first.noEmail}>
                            <svg {...svg} aria-hidden><rect x="3" y="5" width="18" height="14" /><path d="m3 7 9 6 9-6" /></svg>
                          </Has>
                          <Has on={Boolean(r.display.phone?.trim())} yes={H.first.hasPhone} no={H.first.noPhone}>
                            <svg {...svg} aria-hidden><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></svg>
                          </Has>
                        </span>
                      </td>
                      <td className="max-w-[200px] truncate px-2 py-3.5 text-sm text-muted">{originKeyLabel(originKeysOf(r)[0], t)}</td>
                      <td className="px-5 py-3.5 text-right">
                        <Link href={`/leads/ligar/${r.lead.id}`} aria-label={fill(H.first.callFor, { name: r.display.name })} className="inline-flex min-h-11 items-center border border-edge bg-surface px-4 font-medium text-ink no-underline hover:border-ink">
                          {H.first.call} ▸
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
          {sender && (
            <section aria-labelledby="ag-t" className="flex flex-col gap-3.5 border border-line bg-surface p-5">
              <h2 id="ag-t" className={`${label}`}>{H.agents.title}</h2>
              {agents.length === 0 && <p className="m-0 text-sm text-muted">{H.agents.none}</p>}
              {agents.map((a) => {
                const n = found.get(a.id) ?? 0;
                const parts = [
                  ...(a.type === "hunter" ? [n === 1 ? H.agents.foundOne : fill(H.agents.found, { n: n.toLocaleString(t.intl) })] : []),
                  ...(a.status === "running" && a.next_run_at ? [fill(H.agents.next, { d: day(a.next_run_at, t.intl) })] : []),
                ];
                return (
                  <div key={a.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/agentes/${a.id}`} className="font-semibold text-ink no-underline hover:underline">{a.name}</Link>
                      {parts.length > 0 && <div className="mt-0.5 text-sm text-muted">{parts.join(" · ")}</div>}
                    </div>
                    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-[13px] ${a.status === "running" ? "bg-ok-soft text-ok" : "bg-cold text-cold-ink"}`}>
                      <span aria-hidden className="size-2 rounded-full bg-current" />
                      {H.agents.status[a.status]}
                    </span>
                  </div>
                );
              })}
              <Link href="/agentes/novo" className="text-sm font-medium">{agents.length === 0 ? H.agents.createFirst : H.agents.create}</Link>
            </section>
          )}

          {sender && email && (
            <section aria-labelledby="em-t" className="flex flex-col gap-3 border border-line bg-surface p-5">
              <h2 id="em-t" className={`${label}`}>{H.email.title}</h2>
              <dl className="m-0 grid grid-cols-3 gap-2">
                {[[email.sent, H.email.sent], [email.replies, H.email.replies], [rows.filter((r) => r.display.email?.trim()).length, H.email.withEmail]].map(([n, l]) => (
                  <div key={l}>
                    <dd className="m-0 font-display text-[28px] font-extrabold leading-tight">{Number(n).toLocaleString(t.intl)}</dd>
                    <dt className="text-[13px] text-muted">{l}</dt>
                  </div>
                ))}
              </dl>
              {!email.sendingOn && <p role="status" className="m-0 bg-warn-soft px-3 py-2.5 text-sm text-warn">{H.email.off}</p>}
              <Link href="/campanhas" className="text-sm font-medium">{H.email.seeCampaigns}</Link>
            </section>
          )}

          <section aria-labelledby="or-t" className="flex flex-col gap-3.5 border border-line bg-surface p-5">
            <h2 id="or-t" className={`${label}`}>{H.origins.title}</h2>
            {topOrigin.length === 0 && <p className="m-0 text-sm text-muted">{H.origins.none}</p>}
            {topOrigin.map((o) => (
              <div key={o.name} className="flex flex-col gap-1">
                <div className="flex justify-between gap-2 text-sm">
                  <span className="truncate">{originKeyLabel(o.name, t)}</span>
                  <span className="font-mono text-ink">{o.n.toLocaleString(t.intl)}</span>
                </div>
                <div aria-hidden className="h-1.5 bg-cold"><div className="h-1.5 bg-blue" style={{ width: `${Math.max(2, Math.round((o.n / maxOrigin) * 100))}%` }} /></div>
              </div>
            ))}
            <Link href="/leads" className="text-sm font-medium">{H.origins.all}</Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
