import { getT } from "@/lib/i18n/server";
import { PublicShell } from "./ui";

export async function NotConfigured() {
  const t = await getT();
  return (
    <PublicShell>
      <div role="status" className="flex flex-col gap-3">
        <h1 className="text-3xl">{t.notConfigured.title}</h1>
        <p className="m-0 text-base">{t.notConfigured.body}</p>
      </div>
    </PublicShell>
  );
}
