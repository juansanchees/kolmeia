"use client";

import Link from "next/link";
import { useState } from "react";
import { buttonClass, Field, HexPanel, Icon, TextArea } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { Person } from "@/lib/team/types";
import { CallAgentForm } from "./CallAgentForm";
import { HunterStartForm } from "./HunterStartForm";
import { TYPE_ICON } from "./type-icons";

/** One agent type as a big hexagon card: icon, name, what it does, the create action. */
function Card({ title, text, icon, n, children }: { title: string; text: string; icon: string; n: number; children?: React.ReactNode }) {
  return (
    <HexPanel as="article" c={18} style={{ animationDelay: `${0.08 + n * 0.05}s` }} className="k-in flex h-full flex-col gap-3 py-6">
      <span className="hxv inline-flex h-[54px] w-12 items-center justify-center bg-honey text-ink">
        <Icon d={icon} size={24} />
      </span>
      <h3 className="font-body text-xl font-semibold normal-case tracking-normal">{title}</h3>
      <p className="m-0 text-base text-[#4a5361]">{text}</p>
      <div className="mt-auto pt-1">{children}</div>
    </HexPanel>
  );
}

export function AgentGallery({ hasProfile, serviceArea, ai, defaultRegion = "", people = [] }: { hasProfile: boolean; serviceArea: string; ai: boolean; defaultRegion?: string; people?: Person[] }) {
  const t = useT();
  const G = t.agents.gallery;
  const [describe, setDescribe] = useState("");
  const [open, setOpen] = useState(defaultRegion !== "");
  const [seed, setSeed] = useState("");
  const [openCall, setOpenCall] = useState(false);
  const create = () => {
    setSeed(describe.trim());
    setOpen(true);
  };
  const createBtn = buttonClass("secondary", "sm");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl">{G.title}</h2>
        <p className="m-0 text-base text-[#4a5361]">{G.subtitle}</p>
      </div>
      <Field label={G.describe} htmlFor="agent-describe" hint={G.describeHint}>
        <TextArea
          id="agent-describe"
          aria-describedby="agent-describe-hint"
          placeholder={G.describe}
          value={describe}
          maxLength={500}
          rows={2}
          onChange={(e) => setDescribe(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              create();
            }
          }}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card n={0} icon={TYPE_ICON.hunter} title={t.agents.types.hunter} text={G.hunter}>
          <button type="button" onClick={create} className={createBtn}>
            {G.create}
          </button>
        </Card>
        <Card n={1} icon={TYPE_ICON.email} title={t.agents.types.email} text={G.email}>
          <Link href="/agentes/novo/email" className={createBtn}>
            {G.create}
          </Link>
        </Card>
        <Card n={2} icon={TYPE_ICON.call} title={t.agents.types.call} text={G.call}>
          <button type="button" onClick={() => setOpenCall(true)} className={createBtn}>
            {G.create}
          </button>
        </Card>
      </div>
      <p className="m-0 text-base text-[#4a5361]">{G.aiCall}</p>
      {openCall && <CallAgentForm people={people} />}
      {open && <HunterStartForm key={seed} hasProfile={hasProfile} serviceArea={serviceArea} ai={ai} seedText={seed} defaultRegion={defaultRegion} />}
    </div>
  );
}
