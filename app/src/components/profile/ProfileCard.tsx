"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveProfileAction, rejectProfileAction } from "@/app/(app)/leads/perfil/actions";
import { btn, input, Notice } from "@/components/email/bits";
import { Pill } from "@/components/research/controls";
import type { ProfileRow } from "@/lib/profile/queries";
import type { LearnedProfile } from "@/lib/profile/types";
import { cardLines, citeOf } from "@/lib/profile/view";
import { COMPANY_TYPES, type CompanyType } from "@/lib/research/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

type Draft = { texts: string[]; towns: string; types: CompanyType[]; queries: string };

const draftOf = (p: LearnedProfile): Draft => ({
  texts: p.points.map((x) => x.text),
  towns: p.filter.towns.join(", "),
  types: p.filter.companyTypes,
  queries: p.searchQueries.join("\n"),
});

const profileOf = (base: LearnedProfile, d: Draft): LearnedProfile => ({
  points: base.points.map((x, i) => ({ ...x, text: (d.texts[i] ?? x.text).trim() })).filter((x) => x.text),
  filter: { companyTypes: d.types, towns: d.towns.split(",").map((s) => s.trim()).filter(Boolean) },
  searchQueries: d.queries.split("\n").map((s) => s.trim()).filter(Boolean),
});

export function ProfileCard({ profile, hunters }: { profile: ProfileRow; hunters: { id: string; name: string }[] }) {
  const t = useT();
  const M = t.profile;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile.profile));
  const [agent, setAgent] = useState<string>(profile.agent_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const proposed = profile.status === "proposed";
  const p = profile.profile;

  const settle = (r: { ok: true } | { ok: false; error: string }) => {
    if (r.ok) {
      setError(null);
      setEditing(false);
      router.refresh();
    } else setError(r.error); // the draft stays: nothing the owner typed is lost
  };
  const approve = () => start(async () => settle(await approveProfileAction(profile.id, editing ? profileOf(p, draft) : null, agent || null)));
  const discard = () => start(async () => settle(await rejectProfileAction(profile.id)));

  const status = profile.status === "approved" ? fill(M.approved, { version: profile.version ?? 0 }) : M[profile.status];

  return (
    <section aria-labelledby="profile-title" className="flex min-w-0 flex-col gap-4 border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 id="profile-title" className="text-2xl">{profile.source === "results" ? fill(M.results.cardTitle, { rows: profile.sample_rows }) : fill(M.title, { list: profile.list_name, rows: profile.row_count })}</h1>
        <Pill tone={proposed ? "warm" : profile.status === "approved" ? "ok" : "cold"}>{status}</Pill>
      </div>
      {error && <Notice tone="warn" role="alert">{error}</Notice>}

      {editing ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {p.points.map((pt, i) => (
            <li key={i} className="flex flex-col gap-1 text-sm">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-xs text-muted">{M.keys[pt.key]} {citeOf(pt, t)}</span>
                <input value={draft.texts[i] ?? ""} maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, texts: d.texts.map((x, j) => (j === i ? e.target.value : x)) }))} className={input} />
              </label>
            </li>
          ))}
        </ul>
      ) : p.points.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {cardLines(p, t).map((l, i) => (
            <li key={i} className="text-sm">
              <span className="font-semibold">{l.label}:</span> {l.text} <span className="font-mono text-xs text-muted">{l.cite}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted">{M.noPoints}</p>
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <h2 className="text-lg">{M.filterTitle}</h2>
        {editing ? (
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              {M.towns}
              <input value={draft.towns} onChange={(e) => setDraft((d) => ({ ...d, towns: e.target.value }))} className={input} />
            </label>
            <fieldset className="m-0 flex flex-wrap gap-3 border-0 p-0">
              <legend className="mb-1">{M.companyTypes}</legend>
              {COMPANY_TYPES.map((c) => (
                <label key={c} className="flex items-center gap-2">
                  <input type="checkbox" className="size-5" checked={draft.types.includes(c)} onChange={(e) => setDraft((d) => ({ ...d, types: e.target.checked ? [...d.types, c] : d.types.filter((x) => x !== c) }))} />
                  {M.types[c]}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1">
              {M.queries}
              <textarea rows={4} value={draft.queries} onChange={(e) => setDraft((d) => ({ ...d, queries: e.target.value }))} className={input} />
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <p className="m-0">{M.companyTypes}: {p.filter.companyTypes.map((c) => M.types[c]).join(", ") || "—"}</p>
            <p className="m-0">{M.townsLabel}: {p.filter.towns.join(", ") || "—"}</p>
            <p className="m-0 whitespace-pre-line">{M.queriesLabel}: {p.searchQueries.join(" · ") || "—"}</p>
          </div>
        )}
      </div>

      {proposed && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            {M.useIn}
            <select value={agent} onChange={(e) => setAgent(e.target.value)} className={input}>
              <option value="">{M.allHunters}</option>
              {hunters.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </label>
          <p className="m-0 text-sm text-muted">{M.noChange}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={discard} className={btn.danger}>{M.discard}</button>
            <button type="button" disabled={pending} onClick={() => { setError(null); setEditing((v) => !v); }} className={btn.ghost}>{editing ? M.cancelEdit : M.edit}</button>
            <button type="button" disabled={pending} onClick={approve} className={btn.primary}>{M.approve}</button>
          </div>
        </>
      )}
    </section>
  );
}
