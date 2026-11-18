import type { Metadata } from "next";
import { PublicShell } from "@/components/ui";
import { messagesFor } from "@/lib/i18n";
import { USER_AGENT } from "@/lib/qualifier/site/reader";

// Public page the robot's User-Agent points to. Read by site owners in the US, so English by default; ?lang=pt shows Portuguese.
export const metadata: Metadata = { title: "Kolmeia robot", robots: { index: false, follow: false } };

export default async function BotPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const pt = (await searchParams).lang === "pt";
  const B = messagesFor(pt ? "pt" : "en").bot;
  return (
    <PublicShell lang={pt ? "pt-BR" : "en"}>
      <h1 className="text-4xl">{B.title}</h1>
      <p className="m-0 text-lg">{B.intro}</p>
      <section className="flex flex-col gap-1"><h2 className="m-0 font-body text-xl font-semibold normal-case tracking-normal">{B.whoTitle}</h2><p className="m-0 text-base">{B.who}</p></section>
      <section className="flex flex-col gap-1"><h2 className="m-0 font-body text-xl font-semibold normal-case tracking-normal">{B.readsTitle}</h2><p className="m-0 text-base">{B.reads}</p></section>
      <section className="flex flex-col gap-1">
        <h2 className="m-0 font-body text-xl font-semibold normal-case tracking-normal">{B.rulesTitle}</h2>
        <ul className="m-0 list-disc pl-5 text-base"><li>{B.robots}</li><li>{B.rate}</li><li>{B.noLogin}</li></ul>
      </section>
      <section className="flex flex-col gap-1">
        <h2 className="m-0 font-body text-xl font-semibold normal-case tracking-normal">{B.uaTitle}</h2>
        <p className="m-0 text-base">{B.uaLabel}</p>
        <code className="break-all rounded-[10px] bg-ground px-3 py-2 font-mono text-sm">{USER_AGENT}</code>
      </section>
      <a href={pt ? "/bot" : "/bot?lang=pt"} className="k-link text-base underline">{pt ? "English" : "Português"}</a>
    </PublicShell>
  );
}
