"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { startHunterAction } from "@/app/(app)/agentes/agent-actions";
import { AUDIENCES, regionOptions } from "@/lib/agents/hunter";
import { idle } from "@/lib/form-state";
import { Choice, PrimaryButton } from "@/components/research/controls";
import { TextArea, TextInput } from "@/components/ui";
import { t } from "@/messages/pt";

const H = t.agents.hunter;
const OTHER = "__other__";

function QuestionCard({ title, error, children }: { title: string; error?: string; children: React.ReactNode }) {
  return (
    <fieldset className="m-0 flex flex-col gap-3 border border-line bg-surface p-4">
      <legend className="px-1 text-lg">{title}</legend>
      {children}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function HunterStartForm({
  hasProfile,
  serviceArea,
  ai,
  seedText,
  defaultRegion = "",
}: {
  hasProfile: boolean;
  serviceArea: string;
  ai: boolean;
  seedText: string;
  defaultRegion?: string;
}) {
  const [state, action, pending] = useActionState(startHunterAction, idle);
  const err = state.fieldErrors ?? {};
  const [profileSource, setProfileSource] = useState<"saved" | "describe">(hasProfile ? "saved" : "describe");
  const [companyNote, setCompanyNote] = useState("");
  const [audience, setAudience] = useState<(typeof AUDIENCES)[number]>(seedText ? "other" : "builder");
  const [audienceText, setAudienceText] = useState(seedText);
  const options = regionOptions(serviceArea);
  // A region from [Caçar ▸] that is not one of the options pre-fills the "other" text.
  const preset = defaultRegion !== "" && !options.includes(defaultRegion);
  const [regionChoice, setRegionChoice] = useState<string>(preset ? OTHER : defaultRegion || (options[0] ?? OTHER));
  const [regionText, setRegionText] = useState(preset ? defaultRegion : "");
  const region = regionChoice === OTHER ? regionText : regionChoice;

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="profileSource" value={profileSource} />
      <input type="hidden" name="audience" value={audience} />
      <input type="hidden" name="region" value={region} />

      <QuestionCard title={H.q1} error={err.companyNote}>
        <div className="flex flex-wrap gap-2">
          <Choice pressed={profileSource === "saved"} disabled={!hasProfile} onClick={() => setProfileSource("saved")}>
            {H.profileSaved}
          </Choice>
          <Choice pressed={profileSource === "describe"} onClick={() => setProfileSource("describe")}>
            {H.profileDescribe}
          </Choice>
        </div>
        {!hasProfile && (
          <p className="text-sm text-muted">
            {H.noProfile}{" "}
            <Link href="/configuracoes/empresa" className="text-blue underline underline-offset-4">
              {H.fillProfile}
            </Link>
          </p>
        )}
        {profileSource === "describe" && (
          <>
            <TextArea
              name="companyNote"
              aria-label={H.q1}
              rows={3}
              maxLength={1400}
              value={companyNote}
              onChange={(e) => setCompanyNote(e.target.value)}
              placeholder={H.companyNotePlaceholder}
            />
            <p className="text-sm text-muted">{H.describeAdds}</p>
          </>
        )}
      </QuestionCard>

      <QuestionCard title={H.q2} error={err.audienceText}>
        <div className="flex flex-wrap gap-2">
          {AUDIENCES.map((a) => (
            <Choice key={a} pressed={audience === a} onClick={() => setAudience(a)}>
              {H.audiences[a]}
            </Choice>
          ))}
        </div>
        {audience === "other" && (
          <TextInput
            name="audienceText"
            aria-label={H.audienceTextPlaceholder}
            maxLength={500}
            value={audienceText}
            onChange={(e) => setAudienceText(e.target.value)}
            placeholder={H.audienceTextPlaceholder}
          />
        )}
      </QuestionCard>

      <QuestionCard title={H.q3} error={err.region}>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Choice key={o} pressed={regionChoice === o} onClick={() => setRegionChoice(o)} className="max-w-full truncate">
              {o.length > 60 ? `${o.slice(0, 59)}…` : o}
            </Choice>
          ))}
          <Choice pressed={regionChoice === OTHER} onClick={() => setRegionChoice(OTHER)}>
            {H.regionOther}
          </Choice>
        </div>
        {regionChoice === OTHER && (
          <TextInput
            aria-label={H.regionPlaceholder}
            maxLength={1000}
            value={regionText}
            onChange={(e) => setRegionText(e.target.value)}
            placeholder={H.regionPlaceholder}
          />
        )}
      </QuestionCard>

      {!ai && (
        <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          {t.ai.notConfigured} {H.noAiDraft}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <PrimaryButton type="submit" disabled={pending}>
          {H.start}
        </PrimaryButton>
        {state.status === "error" && state.message && (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
