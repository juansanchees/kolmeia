"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { startHunterAction } from "@/app/(app)/agentes/agent-actions";
import { AUDIENCES, regionOptions } from "@/lib/agents/hunter";
import { idle } from "@/lib/form-state";
import { Choice, StepSet } from "@/components/research/controls";
import { Chevron, HexButton, HexPanel, Notice, TextArea, TextInput } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

const OTHER = "__other__";

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
  const t = useT();
  const H = t.agents.hunter;
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
    <HexPanel as="section" aria-label={t.agents.types.hunter} wrapClassName="k-in" className="py-7">
    <form action={action} className="flex flex-col gap-7" noValidate>
      <input type="hidden" name="profileSource" value={profileSource} />
      <input type="hidden" name="audience" value={audience} />
      <input type="hidden" name="region" value={region} />

      <StepSet n={1} title={H.q1} error={err.companyNote}>
        <div className="flex flex-wrap gap-2">
          <Choice pressed={profileSource === "saved"} disabled={!hasProfile} onClick={() => setProfileSource("saved")}>
            {H.profileSaved}
          </Choice>
          <Choice pressed={profileSource === "describe"} onClick={() => setProfileSource("describe")}>
            {H.profileDescribe}
          </Choice>
        </div>
        {!hasProfile && (
          <p className="m-0 text-base text-[#4a5361]">
            {H.noProfile}{" "}
            <Link href="/configuracoes/empresa" className="k-link font-medium text-ink underline decoration-honey decoration-2 underline-offset-4">
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
            <p className="m-0 text-base text-[#4a5361]">{H.describeAdds}</p>
          </>
        )}
      </StepSet>

      <StepSet n={2} title={H.q2} error={err.audienceText}>
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
      </StepSet>

      <StepSet n={3} title={H.q3} error={err.region}>
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
      </StepSet>

      {!ai && (
        <Notice tone="warn">
          {t.ai.notConfigured} {H.noAiDraft}
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <HexButton type="submit" disabled={pending}>
          {H.start} <Chevron className="k-arrow" />
        </HexButton>
        {state.status === "error" && state.message && (
          <p role="alert" className="m-0 text-base font-medium text-danger">
            {state.message}
          </p>
        )}
      </div>
    </form>
    </HexPanel>
  );
}
