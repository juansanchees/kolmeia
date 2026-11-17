"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { btn } from "./bits";
import { outcomeTime, timeOf } from "./format";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type DraftReply = { outcome?: string; code?: keyof Messages["email"]["ai"]; remaining?: number; more?: boolean };

/**
 * Drafting loop driven by this open page: one bounded step per request (a couple of prospects), page data refreshed
 * after each. Closing the page stops it; nothing is lost (the next visit continues). Stops after repeated AI errors.
 */
export function DraftDriver({ campaignId, remaining: initial, autoStart }: { campaignId: string; remaining: number; autoStart: boolean }) {
  const t = useT();
  const M = t.email;
  const router = useRouter();
  const [running, setRunning] = useState(autoStart);
  const [remaining, setRemaining] = useState(initial);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const ctl = new AbortController();
    (async () => {
      let failures = 0;
      while (!stopped) {
        let r: DraftReply;
        try {
          const res = await fetch(`/api/email/campaigns/${campaignId}/draft`, { method: "POST", signal: ctl.signal });
          if (!res.ok) {
            setProblem(M.genericError);
            break;
          }
          r = (await res.json()) as DraftReply;
        } catch {
          if (stopped) break;
          setProblem(M.genericError);
          break;
        }
        if (stopped) break;
        router.refresh();
        if (typeof r.remaining === "number") setRemaining(r.remaining);
        if (r.outcome === "busy") {
          setNote(M.campaign.draftingBusy);
          await sleep(5_000);
          continue;
        }
        if (r.outcome === "ai_error") {
          failures++;
          setProblem(M.ai[r.code ?? "transport"] ?? M.genericError);
          if (!r.more || failures >= 3) break;
          await sleep(3_000);
          continue;
        }
        failures = 0;
        setProblem(null);
        setNote(null);
        if (!r.more) break;
        await sleep(400);
      }
      if (!stopped) setRunning(false);
    })();
    return () => {
      stopped = true;
      ctl.abort();
    };
    // M (messages) is left out on purpose: switching language must not restart the drafting loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, campaignId, router]);

  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      {running ? (
        <p className="m-0 flex items-center gap-2 font-mono text-[14px] text-ink">
          <span aria-hidden="true" className="inline-block size-2.5 animate-pulse rounded-full bg-honey" />
          {note ?? fill(M.campaign.drafting, { n: remaining })}
        </p>
      ) : remaining > 0 ? (
        <div>
          <button type="button" className={btn.primary} onClick={() => setRunning(true)}>
            {M.campaign.draftStart}
          </button>
        </div>
      ) : (
        <p className="m-0 text-base font-medium text-ok">{M.campaign.draftingDone}</p>
      )}
      {problem && (
        <p role="alert" className="m-0 rounded-[14px] border-2 border-[#f0c48f] bg-warn-soft px-4 py-3 text-base text-warn">
          {problem}
        </p>
      )}
    </div>
  );
}

type SendReply = { outcome?: string; waitUntil?: string; error?: string; more?: boolean; stop?: boolean };
type LogLine = { at: string; text: string; tone: "ok" | "warn" | "info" };

/**
 * "Enviar os de hoje": asks the server to send at most one due, approved message per call (the database decides,
 * under limits and suppression), and waits on the screen for the gap between sends. Runs only while this page
 * is open and running.
 */
export function SendDriver({ campaignId, disabled, timezone }: { campaignId: string; disabled?: boolean; timezone?: string }) {
  const t = useT();
  const M = t.email;
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [waitUntil, setWaitUntil] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stopRef = useRef(false);

  useEffect(() => {
    if (!waitUntil) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waitUntil]);

  const add = (text: string, tone: LogLine["tone"]) => setLog((l) => [{ at: new Date().toISOString(), text, tone }, ...l].slice(0, 30));

  async function loop() {
    stopRef.current = false;
    setRunning(true);
    while (!stopRef.current) {
      let r: SendReply;
      try {
        const res = await fetch(`/api/email/campaigns/${campaignId}/send`, { method: "POST" });
        r = (await res.json()) as SendReply;
      } catch {
        add(M.genericError, "warn");
        break;
      }
      router.refresh();
      const outcome = (r.outcome ?? "not_found") as keyof typeof M.send.outcomes;
      // a mailbox that stopped working (password refused / unreadable) ends the loop with one clear message
      const text = r.stop
        ? fill(M.send.mailboxStop, { error: r.error ?? "?" })
        : fill(M.send.outcomes[outcome] ?? M.genericError, { time: outcomeTime(outcome, r.waitUntil, t, timezone), error: r.error ?? "?" });
      if (outcome === "gap" && r.waitUntil) {
        setWaitUntil(r.waitUntil);
        const ms = Math.max(1_000, new Date(r.waitUntil).getTime() - Date.now() + 1_500);
        const end = Date.now() + ms;
        while (!stopRef.current && Date.now() < end) await sleep(500);
        setWaitUntil(null);
        continue;
      }
      add(text, outcome === "sent" || outcome === "dry_run" ? "ok" : outcome === "failed" ? "warn" : "info");
      if (!r.more) break;
      await sleep(500);
    }
    setWaitUntil(null);
    setRunning(false);
  }

  const secondsLeft = waitUntil ? Math.max(0, Math.round((new Date(waitUntil).getTime() - now) / 1000)) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {!running ? (
          <button type="button" className={btn.primary} onClick={loop} disabled={disabled}>
            {M.send.button}
          </button>
        ) : (
          <button
            type="button"
            className={btn.ghost}
            onClick={() => {
              stopRef.current = true;
              add(M.send.stopped, "info");
            }}
          >
            {M.send.stop}
          </button>
        )}
      </div>
      <p className="m-0 text-[14px] text-[#4a5361]">{M.send.limitation}</p>
      <div aria-live="polite" className="flex flex-col gap-1.5">
        {running && (
          <p className="m-0 flex items-center gap-2 font-mono text-[14px] text-ink">
            <span aria-hidden="true" className="inline-block size-2.5 animate-pulse rounded-full bg-honey" />
            {waitUntil ? `${fill(M.send.waitGap, { time: timeOf(waitUntil, t.intl) })} (${secondsLeft}s)` : M.send.running}
          </p>
        )}
        {log.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {log.map((l, i) => (
              <li key={`${l.at}-${i}`} className={`text-[15px] ${l.tone === "ok" ? "text-ok" : l.tone === "warn" ? "text-warn" : "text-ink"}`}>
                <span className="font-mono text-[13px] text-[#4a5361]">{timeOf(l.at, t.intl)}</span> {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
