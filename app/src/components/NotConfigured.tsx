import { t } from "@/messages/pt";

export function NotConfigured() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <div role="status" className="border border-line bg-surface p-6">
        <h1 className="text-2xl">{t.notConfigured.title}</h1>
        <p className="mt-3 text-sm">{t.notConfigured.body}</p>
      </div>
    </main>
  );
}
