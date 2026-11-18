import { Button, Field, TextInput } from "@/components/ui";
import { getT } from "@/lib/i18n/server";

/** "Quero mais clientes": one sentence; a plain GET form, so the suggestions page works without scripts. */
export async function EntryForm({ q = "" }: { q?: string }) {
  const E = (await getT()).hunt.entry;
  return (
    <form action="/agentes/clientes" method="get" className="flex max-w-xl flex-col gap-3">
      <Field label={E.label} htmlFor="hunt-q" hint={E.hint}>
        <TextInput id="hunt-q" name="q" defaultValue={q} placeholder={E.placeholder} maxLength={300} required />
      </Field>
      <div><Button type="submit">{E.submit}</Button></div>
    </form>
  );
}
