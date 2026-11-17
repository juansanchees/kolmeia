"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { trainProfileAction } from "@/app/(app)/leads/perfil/actions";
import { btn } from "@/components/email/bits";
import { usd } from "@/components/research/format";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/**
 * One AI call per click; the proposal it saves changes nothing until it is approved on its own page.
 * `knownProfileId`: newest profile already saved for this list (server data); a fresh training replaces it. The only "see profile" link lives here.
 */
export function TrainButton({ importId, estimateUsd, knownProfileId = null }: { importId: string; estimateUsd: number; knownProfileId?: string | null }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [trainedId, setProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const profileId = trainedId ?? knownProfileId;

  const train = () =>
    start(async () => {
      const r = await trainProfileAction(importId);
      if (r.ok) {
        setError(null);
        setProfileId(r.profileId);
      } else setError(r.error);
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={pending} onClick={train} className={btn.ghost}>
        {pending ? t.profile.working : fill(t.profile.train, { usd: usd(estimateUsd, t.intl) })}
      </button>
      {profileId && <Link href={`/leads/perfil/${profileId}`} className={btn.link}>{t.profile.see}</Link>}
      {error && <p role="alert" className="m-0 w-full text-sm text-danger">{error}</p>}
    </div>
  );
}
