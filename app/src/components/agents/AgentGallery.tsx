"use client";

import Link from "next/link";
import { useState } from "react";
import { GhostButton } from "@/components/research/controls";
import { t } from "@/messages/pt";
import type { Person } from "@/lib/team/types";
import { CallAgentForm } from "./CallAgentForm";
import { HunterStartForm } from "./HunterStartForm";

const G = t.agents.gallery;

function Card({ title, text, children, off }: { title: string; text: string; children?: React.ReactNode; off?: boolean }) {
  return (
    <div className={`flex flex-col gap-2 border p-4 ${off ? "border-line bg-ground text-muted" : "border-line bg-surface"}`}>
      <h3 className="text-xl">{title}</h3>
      <p className="text-sm">{text}</p>
      <div className="mt-auto pt-1">{children}</div>
    </div>
  );
}

export function AgentGallery({ hasProfile, serviceArea, ai, defaultRegion = "", people = [] }: { hasProfile: boolean; serviceArea: string; ai: boolean; defaultRegion?: string; people?: Person[] }) {
  const [describe, setDescribe] = useState("");
  const [open, setOpen] = useState(defaultRegion !== "");
  const [seed, setSeed] = useState("");
  const [openCall, setOpenCall] = useState(false);
  const create = () => {
    setSeed(describe.trim());
    setOpen(true);
  };
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl">{G.title}</h2>
      <textarea
        aria-label={G.describe}
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
        className="w-full border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink/50"
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title={t.agents.types.hunter} text={G.hunter}>
          <GhostButton onClick={create}>{G.create}</GhostButton>
        </Card>
        <Card title={t.agents.types.email} text={G.email}>
          <Link href="/agentes/novo/email" className="inline-flex min-h-11 items-center border border-edge bg-surface px-4 text-[15px] font-medium text-ink hover:border-ink">
            {G.create}
          </Link>
        </Card>
        <Card title={t.agents.types.call} text={G.call}>
          <GhostButton onClick={() => setOpenCall(true)}>{G.create}</GhostButton>
        </Card>
      </div>
      <p className="text-sm text-muted">{G.aiCall}</p>
      {openCall && <CallAgentForm people={people} />}
      {open && <HunterStartForm key={seed} hasProfile={hasProfile} serviceArea={serviceArea} ai={ai} seedText={seed} defaultRegion={defaultRegion} />}
    </div>
  );
}
