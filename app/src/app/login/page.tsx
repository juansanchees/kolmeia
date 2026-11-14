import { redirect } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { LoginForm } from "./LoginForm";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!hasSupabase) return <NotConfigured />;
  if (await getUser()) redirect("/");
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <LoginForm />
    </main>
  );
}
