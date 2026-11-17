import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { INVITE_COLUMNS, type InviteRow, type Person } from "@/lib/team/types";
import { HexPanel, StepTitle } from "@/components/ui";
import { InviteForm } from "@/components/team/InviteForm";
import { PeopleList } from "@/components/team/PeopleList";
import { getT } from "@/lib/i18n/server";

export default async function TeamPage() {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  if (!workspace || workspace.role !== "owner") redirect("/leads");
  const supabase = await createClient();
  if (!supabase) return null;

  const [people, invites] = await Promise.all([
    supabase.rpc("list_workspace_people", { p_ws: workspace.id }),
    supabase
      .from("workspace_invites")
      .select(INVITE_COLUMNS)
      .eq("workspace_id", workspace.id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-lg text-[#4a5361]">{t.team.subtitle}</p>
      <div className="flex flex-wrap items-start gap-5">
        <HexPanel as="section" aria-labelledby="team-people" wrapClassName="k-in flex-[2_1_380px]" className="flex flex-col gap-4 py-6">
          <div id="team-people"><StepTitle n={1} hint={t.team.peopleHint}>{t.team.people}</StepTitle></div>
          <PeopleList people={(people.data ?? []) as Person[]} invites={(invites.data ?? []) as InviteRow[]} />
        </HexPanel>
        <HexPanel as="section" aria-labelledby="team-invite" wrapClassName="k-in flex-[1_1_320px]" className="flex flex-col gap-4 py-6">
          <div id="team-invite"><StepTitle n={2} hint={t.team.inviteHint}>{t.team.invite}</StepTitle></div>
          <InviteForm />
        </HexPanel>
      </div>
    </div>
  );
}
