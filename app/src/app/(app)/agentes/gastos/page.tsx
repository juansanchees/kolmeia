import Link from "next/link";
import { Notice } from "@/components/email/bits";
import { QualifierCapForm } from "@/components/qualifier/QualifierCapForm";
import { TakeOverButton } from "@/components/qualifier/TakeOverButton";
import { SourceSpend, SpendTable, money } from "@/components/spend/SpendTable";
import { loadSourceRuns, loadSpend, loadWorkspaceToday } from "@/lib/spend/queries";
import { sourceRows, spendRows, spendTotal, type SpendBy, type SpendPeriod } from "@/lib/spend/view";
import type { QualifierStatus } from "@/lib/qualifier/view";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill, t } from "@/messages/pt";

const S = t.spend;
const BY: Record<string, SpendBy> = { agente: "agent", passo: "step", modelo: "model", lead: "lead", dia: "day" };
const PERIOD: Record<string, SpendPeriod> = { hoje: "today", "7d": "7d", "30d": "30d" };
const BY_LABEL: Record<SpendBy, string> = { agent: S.by.agent, step: S.by.step, model: S.by.model, lead: S.by.lead, day: S.by.day };
const PERIOD_LABEL: Record<SpendPeriod, string> = { today: S.period.today, "7d": S.period.d7, "30d": S.period.d30 };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const chip = "inline-flex min-h-11 items-center border px-4 text-sm no-underline";

export default async function GastosPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
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
      loadSourceRuns(supabase, workspace.id, period),
      loadWorkspaceToday(supabase, workspace.id),
      supabase.rpc("qualifier_status", { p_ws: workspace.id }),
    ]);
    if (st.error || !st.data) throw new Error("status");
    data = { spend, sources, ws, q: st.data as QualifierStatus };
  } catch {
    return <Notice tone="warn">{S.failed}</Notice>;
  }
  const { spend, sources, ws, q } = data;
  const rows = spendRows(spend.calls, by, spend);
  const src = sourceRows(sources);
  const href = (b: string, p: string) => `/agentes/gastos?por=${b}&periodo=${p}`;
  const on = (active: boolean) => (active ? "border-blue bg-blue text-white" : "border-line bg-surface text-ink hover:bg-ground");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href="/agentes" className="text-sm text-blue underline underline-offset-4">
          {S.back}
        </Link>
        <h2 className="text-3xl">{S.title}</h2>
      </div>
      {q.status === "paused" && q.paused_reason && (
        <Notice tone="warn">
          <span className="flex flex-wrap items-center gap-3">
            <span>{t.qualifier.paused[q.paused_reason]}</span>
            {workspace.role === "owner" && q.paused_reason === "no_access" && <TakeOverButton />}
          </span>
        </Notice>
      )}
      <div className="flex flex-col gap-1 text-sm font-semibold">
        <p>{fill(S.qualifierToday, { spent: money(q.spent_today), cap: money(q.daily_cap_usd) })}</p>
        <p>{fill(S.workspaceToday, { spent: money(ws.spent), cap: money(ws.cap) })}</p>
      </div>
      <QualifierCapForm status={q} />
      <div className="flex flex-wrap gap-x-6 gap-y-2" aria-label="filtros">
        <div role="group" aria-label={S.by.label} className="flex flex-wrap gap-2">
          {(Object.keys(BY) as string[]).map((k) => (
            <Link key={k} href={href(k, periodKey)} aria-current={BY[k] === by ? "true" : undefined} className={`${chip} ${on(BY[k] === by)}`}>
              {BY_LABEL[BY[k]]}
            </Link>
          ))}
        </div>
        <div role="group" aria-label={S.period.label} className="flex flex-wrap gap-2">
          {Object.keys(PERIOD).map((k) => (
            <Link key={k} href={href(byKey, k)} aria-current={PERIOD[k] === period ? "true" : undefined} className={`${chip} ${on(PERIOD[k] === period)}`}>
              {PERIOD_LABEL[PERIOD[k]]}
            </Link>
          ))}
        </div>
      </div>
      <p className="text-sm font-semibold">{fill(S.total, { usd: money(spendTotal(spend.calls)) })}</p>
      <SpendTable rows={rows} by={by} />
      <p className="text-[13px] text-muted">{S.pendingNote}</p>
      {spend.truncated && <Notice tone="warn">{S.truncated}</Notice>}
      <SourceSpend rows={src} />
      <p className="text-sm font-semibold">{fill(S.sourcesTotal, { usd: money(src.reduce((s, r) => s + r.usd, 0)) })}</p>
    </div>
  );
}
