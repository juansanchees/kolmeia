"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveProfileAction, rejectProfileAction } from "@/app/(app)/leads/perfil/actions";
import { Button, HexPanel, Notice, Select, StepTitle, TextArea, TextInput } from "@/components/ui";
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

  const mono = "font-mono text-[13px] font-medium uppercase tracking-wide";
  return (
    <HexPanel as="section" aria-labelledby="profile-title" c={22} cSm={12} raised className="flex min-w-0 flex-col gap-6 py-7" wrapClassName="k-in [animation-delay:.08s]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="profile-title" className="min-w-0 break-words text-[28px] md:text-[32px]">{profile.source === "results" ? fill(M.results.cardTitle, { rows: profile.sample_rows }) : fill(M.title, { list: profile.list_name, rows: profile.row_count })}</h2>
        <Pill tone={proposed ? "warm" : profile.status === "approved" ? "ok" : "cold"}>{status}</Pill>
      </div>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}

      <div className="k-step flex flex-col gap-3">
        <StepTitle n={1}>{M.pointsTitle}</StepTitle>
        {editing ? (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {p.points.map((pt, i) => (
              <li key={i} className="flex flex-col gap-1">
                <label className="flex flex-col gap-1.5">
                  <span className={mono}>{M.keys[pt.key]} {citeOf(pt, t)}</span>
                  <TextInput value={draft.texts[i] ?? ""} maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, texts: d.texts.map((x, j) => (j === i ? e.target.value : x)) }))} />
                </label>
              </li>
            ))}
          </ul>
        ) : p.points.length ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {cardLines(p, t).map((l, i) => (
              <li key={i} className="rounded-[14px] bg-ground px-4 py-3 text-base">
                <span className="font-semibold">{l.label}:</span> {l.text} <span className="font-mono text-sm text-[#4a5361]">{l.cite}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-base text-[#4a5361]">{M.noPoints}</p>
        )}
      </div>

      <div className="k-step flex flex-col gap-3 border-t border-[#e3e6ec] pt-5">
        <StepTitle n={2}>{M.filterTitle}</StepTitle>
        {editing ? (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className={mono}>{M.towns}</span>
              <TextInput value={draft.towns} onChange={(e) => setDraft((d) => ({ ...d, towns: e.target.value }))} />
            </label>
            <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
              <legend className={`${mono} mb-2`}>{M.companyTypes}</legend>
              {COMPANY_TYPES.map((c) => (
                <label key={c} className="k-opt flex min-h-11 items-center gap-2 rounded-full border-2 border-line bg-surface px-4 text-base">
                  <input type="checkbox" className="size-5" checked={draft.types.includes(c)} onChange={(e) => setDraft((d) => ({ ...d, types: e.target.checked ? [...d.types, c] : d.types.filter((x) => x !== c) }))} />
                  {M.types[c]}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1.5">
              <span className={mono}>{M.queries}</span>
              <TextArea rows={4} value={draft.queries} onChange={(e) => setDraft((d) => ({ ...d, queries: e.target.value }))} />
            </label>
          </div>
        ) : (
          <dl className="m-0 flex flex-col gap-2 text-base">
            <div className="flex flex-wrap gap-x-2"><dt className="font-semibold">{M.companyTypes}:</dt><dd className="m-0">{p.filter.companyTypes.map((c) => M.types[c]).join(", ") || "—"}</dd></div>
            <div className="flex flex-wrap gap-x-2"><dt className="font-semibold">{M.townsLabel}:</dt><dd className="m-0">{p.filter.towns.join(", ") || "—"}</dd></div>
            <div className="flex flex-wrap gap-x-2"><dt className="font-semibold">{M.queriesLabel}:</dt><dd className="m-0 whitespace-pre-line">{p.searchQueries.join(" · ") || "—"}</dd></div>
          </dl>
        )}
      </div>

      {proposed && (
        <div className="k-step flex flex-col gap-4 border-t border-[#e3e6ec] pt-5">
          <StepTitle n={3} hint={M.noChange}>{M.decideTitle}</StepTitle>
          <label className="flex max-w-md flex-col gap-1.5">
            <span className={mono}>{M.useIn}</span>
            <Select value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">{M.allHunters}</option>
              {hunters.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </Select>
          </label>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button type="button" disabled={pending} onClick={approve}>{M.approve}</Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => { setError(null); setEditing((v) => !v); }}>{editing ? M.cancelEdit : M.edit}</Button>
            <Button type="button" variant="danger" size="sm" disabled={pending} onClick={discard}>{M.discard}</Button>
          </div>
        </div>
      )}
    </HexPanel>
  );
}
