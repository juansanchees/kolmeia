import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { t } from "@/messages/pt";
import { SETTINGS_HREF } from "@/lib/nav";
import type { Role } from "@/lib/roles";
import { NavLinks } from "./NavLinks";
import { KolmeiaMark } from "./Logo";

export function Header({ workspaceName, role }: { workspaceName: string; role: Role }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-display text-xl uppercase tracking-wide">
          <KolmeiaMark />
          {workspaceName}
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={SETTINGS_HREF}
            aria-label={t.nav.settings}
            title={t.nav.settings}
            className="flex min-h-11 min-w-11 items-center justify-center text-lg"
          >
            <span aria-hidden>⚙</span>
          </Link>
          <form action={signOut}>
            <button type="submit" className="min-h-11 font-mono text-xs uppercase underline underline-offset-4">
              {t.signOut}
            </button>
          </form>
        </div>
      </div>
      <NavLinks variant="top" role={role} />
    </header>
  );
}
