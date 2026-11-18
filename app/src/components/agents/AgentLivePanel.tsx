"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runHunterNowAction } from "@/app/(app)/agentes/agent-actions";
import { usd } from "@/components/research/format";
import { Badge, HexButton, HexPanel, Notice } from "@/components/ui";
import { when } from "@/components/email/format";
import { useT } from "@/lib/i18n/client";
import type { AgentLive, AgentLiveState } from "@/lib/agents/live";
import { STAGES } from "@/lib/research/types";

export const LIVE_FAST_MS = 3000;
export const LIVE_SLOW_MS = 30000;

const BUSY: AgentLiveState[] = ["queued", "running"];
const CAN_RUN: AgentLiveState[] = ["idle", "done", "failed", "paused"];
const hexDot = "size-4 [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)]";

/** What the Hunter is doing right now. Polls the live route (fast while busy, slow otherwise, paused when the tab is hidden). */
export function AgentLivePanel({ agentId, initial, canRun }: { agentId: string; initial: AgentLive; canRun: boolean }) {
  const t = useT();
  const L = t.agents.live;
  const router = useRouter();
  const [live, setLive] = useState(initial);
  const [now, setNow] = useState<number | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const prev = useRef(initial.state);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctl: AbortController | undefined;
    let alive = true;
    const stop = () => {
      clearTimeout(timer);
      ctl?.abort();
    };
    const tick = async () => {
      stop();
      if (!alive || document.hidden) return;
      ctl = new AbortController();
      let next = prev.current;
      try {
        const res = await fetch(`/api/agents/${agentId}/live`, { cache: "no-store", signal: ctl.signal });
        if (res.ok) {
          const data = (await res.json()) as AgentLive;
          next = data.state;
          if (alive) {
            setLive(data);
            setNow(Date.now());
          }
          if (BUSY.includes(prev.current) && data.state === "done") router.refresh();
          prev.current = data.state;
        }
      } catch {
        if (!alive) return;
      }
      if (alive) timer = setTimeout(tick, BUSY.includes(next) ? LIVE_FAST_MS : LIVE_SLOW_MS);
    };
    const onVisibility = () => (document.hidden ? stop() : void tick());
    kick.current = () => void tick();
    setNow(Date.now());
    timer = setTimeout(tick, BUSY.includes(prev.current) ? LIVE_FAST_MS : LIVE_SLOW_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agentId, router]);

  const run = useCallback(
    () =>
      start(async () => {
        setInfo(null);
        setError(null);
        const r = await runHunterNowAction(agentId);
        if (r.status === "error") setError(r.message ?? t.agents.hunter.errors.failed);
        else {
          if (r.message) setInfo(r.message);
          kick.current();
        }
      }),
    [agentId, t],
  );

  const { state, run: r } = live;
  const busy = BUSY.includes(state);
  const stageIdx = state === "done" ? STAGES.length : state === "running" || state === "paused" ? STAGES.indexOf((r?.stage ?? "") as (typeof STAGES)[number]) : -1;
  const currentLabel = state === "running" && stageIdx >= 0 ? L.stages[STAGES[stageIdx]] : null;
  const minutes = r?.startedAt && now ? Math.max(0, Math.floor((now - new Date(r.startedAt).getTime()) / 60000)) : null;
  const statusLabel = state === "paused" ? L.paused[(live.pausedReason ?? "default") as keyof typeof L.paused] ?? L.paused.default : L.states[state];
  const muted = busy ? "text-[#dfe4f0]" : "text-[#4a5361]";

  return (
    <HexPanel as="section" tone={busy ? "navy" : "white"} aria-labelledby="agent-live-title" raised={busy} wrapClassName="k-in" className="flex flex-col gap-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="agent-live-title" className="m-0 flex flex-wrap items-center gap-2.5 font-body text-lg font-semibold normal-case tracking-normal">
          <span>{L.title}</span>
          <Badge tone={state === "failed" ? "danger" : state === "paused" ? "warn" : busy ? "honey" : "neutral"} dot={busy}>
            {statusLabel}
          </Badge>
        </h3>
        {canRun && CAN_RUN.includes(state) && (
          <HexButton type="button" tone="honey" disabled={pending} onClick={run}>
            {pending ? L.starting : L.runNow}
          </HexButton>
        )}
      </div>

      <div aria-live="polite" className="flex flex-col gap-3">
        {(state === "running" || state === "done") && (
          <div className="flex flex-wrap items-center gap-3">
            <ol className="m-0 flex list-none items-center gap-1.5 p-0" aria-hidden>
              {STAGES.map((s, i) => (
                <li
                  key={s}
                  className={`${hexDot} ${i < stageIdx ? "bg-honey" : i === stageIdx ? "animate-pulse bg-honey ring-2 motion-reduce:animate-none" : "bg-[#d5dae3]"}`}
                />
              ))}
            </ol>
            {currentLabel && <span className="text-base font-semibold">{currentLabel}</span>}
          </div>
        )}
        {state === "queued" && <p className="m-0 text-base">{L.queuedHint}</p>}
        {state === "failed" && <p className="m-0 text-base">{L.failedLine}</p>}
        {state === "idle" && <p className="m-0 text-base">{L.idleLine}</p>}

        {r && state !== "idle" && state !== "queued" && (
          <p className={`m-0 text-base ${muted}`}>
            {(r.maxFound ? L.found.replace("{max}", String(r.maxFound)) : L.foundNoMax).replace("{n}", String(r.found))}
            {" · "}
            {(r.maxUsd != null ? L.spent.replace("{max}", usd(r.maxUsd, t.intl)) : L.spentNoMax).replace("{spent}", usd(r.spentUsd, t.intl))}
            {state === "running" && minutes !== null && ` · ${minutes > 0 ? L.started.replace("{m}", String(minutes)) : L.startedNow}`}
          </p>
        )}
        {r?.lastName && state !== "idle" && state !== "queued" && <p className={`m-0 text-base ${muted}`}>{L.last.replace("{name}", `"${r.lastName}"`)}</p>}
        {!busy && live.nextRunAt && new Date(live.nextRunAt).getTime() > (now ?? 0) && now !== null && (
          <p className={`m-0 text-base ${muted}`}>{L.next.replace("{when}", when(live.nextRunAt, t.intl))}</p>
        )}
      </div>

      {live.stale && <Notice tone="warn">{L.stale}</Notice>}
      {info && <Notice tone="info">{info}</Notice>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </HexPanel>
  );
}
