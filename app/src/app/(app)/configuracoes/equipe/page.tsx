import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { INVITE_COLUMNS, type InviteRow, type Person } from "@/lib/team/types";
import { Card, CardTitle } from "@/components/email/bits";
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
    <div className="flex flex-wrap items-start gap-5">
      <Card aria-labelledby="team-people" className="flex-[2_1_380px]">
        <CardTitle id="team-people">{t.team.people}</CardTitle>
        <PeopleList people={(people.data ?? []) as Person[]} invites={(invites.data ?? []) as InviteRow[]} />
      </Card>
      <Card aria-labelledby="team-invite" className="flex-[1_1_320px]">
        <CardTitle id="team-invite">{t.team.invite}</CardTitle>
        <InviteForm />
      </Card>
    </div>
  );
}
