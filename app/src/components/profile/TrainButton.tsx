"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { trainProfileAction } from "@/app/(app)/leads/perfil/actions";
import { btn } from "@/components/email/bits";
import { usd } from "@/components/research/format";
import { fill, t } from "@/messages/pt";

/** One AI call per click; the proposal it saves changes nothing until it is approved on its own page. */
export function TrainButton({ importId, estimateUsd }: { importId: string; estimateUsd: number }) {
  const [pending, start] = useTransition();
  const [profileId, setProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        {pending ? t.profile.working : fill(t.profile.train, { usd: usd(estimateUsd) })}
      </button>
      {profileId && <Link href={`/leads/perfil/${profileId}`} className={btn.link}>{t.profile.see}</Link>}
      {error && <p role="alert" className="m-0 w-full text-sm text-danger">{error}</p>}
    </div>
  );
}
