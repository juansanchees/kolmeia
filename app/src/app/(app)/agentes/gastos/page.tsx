import Link from "next/link";
import { CountPill, HexPanel, Notice, segItemCls, segWrapCls } from "@/components/ui";
import { Meter } from "@/components/research/controls";
import { QualifierCapForm } from "@/components/qualifier/QualifierCapForm";
import { TakeOverButton } from "@/components/qualifier/TakeOverButton";
import { SourceSpend, SpendTable, money } from "@/components/spend/SpendTable";
import { loadSourceRuns, loadSpend, loadWorkspaceToday } from "@/lib/spend/queries";
import { grandTotal, sourceRows, spendRows, spendTotal, type SpendBy, type SpendPeriod } from "@/lib/spend/view";
import type { QualifierStatus } from "@/lib/qualifier/view";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const BY: Record<string, SpendBy> = { agente: "agent", passo: "step", modelo: "model", lead: "lead", dia: "day" };
const PERIOD: Record<string, SpendPeriod> = { hoje: "today", "7d": "7d", "30d": "30d" };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function GastosPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const t = await getT();
  const S = t.spend;
  const BY_LABEL: Record<SpendBy, string> = { agent: S.by.agent, step: S.by.step, model: S.by.model, lead: S.by.lead, day: S.by.day };
  const PERIOD_LABEL: Record<SpendPeriod, string> = { today: S.period.today, "7d": S.period.d7, "30d": S.period.d30 };
  const workspace = await requireSender();
  const sp = await searchParams;
  const by = BY[pick(sp.por) ?? ""] ?? "agent";
  const period = PERIOD[pick(sp.periodo) ?? ""] ?? "today";
  const byKey = Object.entries(BY).find(([, v]) => v === by)![0];
  const periodKey = Object.entries(PERIOD).find(([, v]) => v === period)![0];
  const supabase = await createClient();
  if (!supabase) return <Notice tone="warn">{S.failed}</Notice>;

  let data;
  try {
    const [spend, sources, ws, st] = await Promise.all([
      loadSpend(supabase, workspace.id, period),
      loadSourceRuns(supabase, workspace.id, period, t),
      loadWorkspaceToday(supabase, workspace.id),
      supabase.rpc("qualifier_status", { p_ws: workspace.id }),
    ]);
    if (st.error || !st.data) throw new Error("status");
    data = { spend, sources, ws, q: st.data as QualifierStatus };
  } catch {
    return <Notice tone="warn">{S.failed}</Notice>;
  }
  const { spend, sources, ws, q } = data;
  const rows = spendRows(spend.calls, by, spend, t);
  const src = sourceRows(sources, t);
  const href = (b: string, p: string) => `/agentes/gastos?por=${b}&periodo=${p}`;

  // "Total no período: US$ {usd}" with the amount in a pill (the template keeps its words, only {usd} moves)
  const total = (template: string, usd: string, tone: "honey" | "navy" = "honey") => {
    const [before, after = ""] = template.split("{usd}");
    return (
      <>
        {before}
        <CountPill tone={tone} className="text-base">{usd}</CountPill>
        {after}
      </>
    );
  };
  const today = [
    { text: fill(S.qualifierToday, { spent: money(q.spent_today, t.intl), cap: money(q.daily_cap_usd, t.intl) }), value: q.spent_today, max: q.daily_cap_usd },
    { text: fill(S.workspaceToday, { spent: money(ws.spent, t.intl), cap: money(ws.cap, t.intl) }), value: ws.spent, max: ws.cap },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="k-in flex flex-col gap-1">
        <Link href="/agentes" className="k-link inline-flex min-h-11 items-center self-start text-base font-medium text-ink underline decoration-honey decoration-2 underline-offset-4">
          {S.back}
        </Link>
        <h2 className="text-3xl">{S.title}</h2>
        <p className="m-0 text-base text-[#4a5361]">{S.subtitle}</p>
      </div>
      {q.status === "paused" && q.paused_reason && (
        <Notice tone="warn">
          <span className="flex flex-wrap items-center gap-3">
            <span>{t.qualifier.paused[q.paused_reason]}</span>
            {workspace.role === "owner" && q.paused_reason === "no_access" && <TakeOverButton />}
          </span>
        </Notice>
      )}
      <div className="k-in grid gap-3 [animation-delay:.06s] sm:grid-cols-2">
        {today.map((x) => (
          <div key={x.text} className="flex flex-col gap-2.5 rounded-2xl border border-[#e3e6ec] bg-surface p-4 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)]">
            <p className="m-0 text-base font-semibold">{x.text}</p>
            <Meter value={x.value} max={x.max} />
          </div>
        ))}
      </div>
      <QualifierCapForm status={q} />
      <div className="flex flex-wrap gap-x-6 gap-y-3" aria-label={S.filtersLabel}>
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{S.by.label}</span>
          <div role="group" aria-label={S.by.label} className={segWrapCls}>
            {(Object.keys(BY) as string[]).map((k) => (
              <Link key={k} href={href(k, periodKey)} aria-current={BY[k] === by ? "true" : undefined} className={segItemCls(BY[k] === by)}>
                {BY_LABEL[BY[k]]}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{S.period.label}</span>
          <div role="group" aria-label={S.period.label} className={segWrapCls}>
            {Object.keys(PERIOD).map((k) => (
              <Link key={k} href={href(byKey, k)} aria-current={PERIOD[k] === period ? "true" : undefined} className={segItemCls(PERIOD[k] === period)}>
                {PERIOD_LABEL[PERIOD[k]]}
              </Link>
            ))}
          </div>
        </div>
      </div>
      <HexPanel as="section" aria-label={S.title} wrapClassName="k-in [animation-delay:.1s]" className="flex flex-col gap-4 py-6">
        <p className="m-0 text-base font-semibold">{total(S.total, money(spendTotal(spend.calls), t.intl))}</p>
        <SpendTable rows={rows} by={by} />
        <p className="m-0 text-[15px] text-[#4a5361]">{S.pendingNote}</p>
        {spend.truncated && <Notice tone="warn">{S.truncated}</Notice>}
      </HexPanel>
      <HexPanel wrapClassName="k-in [animation-delay:.14s]" className="flex flex-col gap-4 py-6">
        <SourceSpend rows={src} />
        <p className="m-0 text-base font-semibold">{total(S.sourcesTotal, money(src.reduce((s, r) => s + r.usd, 0), t.intl))}</p>
      </HexPanel>
      <HexPanel tone="honey" c={18} wrapClassName="k-in [animation-delay:.18s]" className="py-5">
        <p className="m-0 text-lg font-semibold">
          {total(S.grandTotal, money(grandTotal(spend.calls, sources), t.intl), "navy")}
          {spend.truncated ? ` ${S.partial}` : ""}
        </p>
      </HexPanel>
    </div>
  );
}
