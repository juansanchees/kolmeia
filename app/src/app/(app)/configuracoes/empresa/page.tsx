import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { isSender } from "@/lib/roles";
import { WANTED_WORK, type ProfileInput } from "@/lib/profile-schema";
import { t } from "@/messages/pt";
import { ProfileForm } from "./ProfileForm";

export default async function CompanyPage() {
  const workspace = await getCurrentWorkspace();
  const supabase = await createClient();
  let initial: ProfileInput = { what_we_do: "", service_area: "", wanted_work: [], good_customer: "", not_wanted: "" };

  if (supabase && workspace) {
    const { data } = await supabase
      .from("company_profiles")
      .select("what_we_do, service_area, wanted_work, good_customer, not_wanted")
      .eq("workspace_id", workspace.id)
      .maybeSingle();
    if (data) {
      initial = {
        what_we_do: data.what_we_do,
        service_area: data.service_area,
        good_customer: data.good_customer,
        not_wanted: data.not_wanted,
        wanted_work: (data.wanted_work as string[]).filter((w): w is ProfileInput["wanted_work"][number] =>
          (WANTED_WORK as readonly string[]).includes(w),
        ),
      };
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-3xl">{t.company.title}</h2>
      <p className="text-sm">{t.company.intro}</p>
      <ProfileForm initial={initial} readOnly={!workspace || !isSender(workspace.role)} />
    </section>
  );
}
