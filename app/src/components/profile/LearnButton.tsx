"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { learnFromResultsAction } from "@/app/(app)/leads/perfil/actions";
import { Button, LinkButton } from "@/components/ui";
import { usd } from "@/components/research/format";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/** One AI call after a confirm; the proposal opens on its own page and changes nothing until approved. `blocked`: why it cannot run yet. */
export function LearnButton({ estimateUsd, blocked }: { estimateUsd: number; blocked: string | null }) {
  const t = useT();
  const R = t.profile.results;
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const learn = () =>
    start(async () => {
      const r = await learnFromResultsAction();
      if (r.ok) router.push(`/leads/perfil/${r.profileId}`);
      else {
        setError(r.error);
        setConfirming(false);
      }
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2.5">
        {confirming ? (
          <>
            <Button type="button" disabled={pending} onClick={learn}>
              {pending ? R.working : fill(R.confirm, { usd: usd(estimateUsd, t.intl) })}
            </Button>
            <LinkButton type="button" disabled={pending} onClick={() => setConfirming(false)}>
              {R.cancel}
            </LinkButton>
          </>
        ) : (
          <Button type="button" variant="secondary" disabled={Boolean(blocked)} aria-describedby={blocked ? "learn-blocked" : undefined} onClick={() => { setError(null); setConfirming(true); }}>
            {fill(R.learn, { usd: usd(estimateUsd, t.intl) })}
          </Button>
        )}
      </div>
      {blocked && <p id="learn-blocked" className="m-0 text-base text-[#4a5361]">{blocked}</p>}
      {error && <p role="alert" className="m-0 text-base text-danger">{error}</p>}
    </div>
  );
}
