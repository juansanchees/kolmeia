import { listCsv } from "@/lib/lists/queries";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// "Exportar CSV" of one list: owner and sdr only, built here from the leads the user can read (RLS), formula-escaped.
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const workspace = await getCurrentWorkspace();
  if (!workspace) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!isSender(workspace.role)) return Response.json({ error: "forbidden" }, { status: 403 });
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const out = await listCsv(supabase, workspace.id, id, await getT());
  if (!out) return Response.json({ error: "not_found" }, { status: 404 });
  return new Response(out.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="lista-${id.slice(0, 8)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
