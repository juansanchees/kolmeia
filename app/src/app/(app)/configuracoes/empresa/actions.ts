"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { profileSchema } from "@/lib/profile-schema";
import type { FormState } from "@/lib/form-state";
import { t } from "@/messages/pt";

const fieldMessages: Record<string, string> = {
  what_we_do: t.company.errors.whatWeDo,
  service_area: t.company.errors.serviceArea,
  wanted_work: t.company.errors.wantedWork,
  good_customer: t.company.errors.goodCustomer,
  not_wanted: t.company.errors.notWanted,
};

export async function saveProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = profileSchema.safeParse({
    what_we_do: formData.get("what_we_do") ?? "",
    service_area: formData.get("service_area") ?? "",
    wanted_work: formData.getAll("wanted_work"),
    good_customer: formData.get("good_customer") ?? "",
    not_wanted: formData.get("not_wanted") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && key in fieldMessages) fieldErrors[key] = fieldMessages[key];
    }
    return { status: "error", fieldErrors };
  }

  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  if (!supabase || !workspace) return { status: "error", message: t.company.errors.noWorkspace };

  // The workspace comes from the session (RLS also enforces membership); updated_by/updated_at are set by a trigger.
  // Column-level grants: update may not name workspace_id, so this is update-then-insert, not an upsert
  // (an upsert would send workspace_id in its SET list). If two saves race on the first insert, retry the update once.
  const update = () =>
    supabase.from("company_profiles").update(parsed.data).eq("workspace_id", workspace.id).select("workspace_id");
  const first = await update();
  let error = first.error;
  if (!error && (first.data?.length ?? 0) === 0) {
    ({ error } = await supabase.from("company_profiles").insert({ workspace_id: workspace.id, ...parsed.data }));
    if (error?.code === "23505") ({ error } = await update());
  }
  if (error) return { status: "error", message: t.company.errors.generic };
  return { status: "success", message: t.company.saved };
}
