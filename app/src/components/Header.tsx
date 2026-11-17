import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { getT } from "@/lib/i18n/server";
import { SETTINGS_HREF } from "@/lib/nav";
import type { Role } from "@/lib/roles";
import { NavLinks } from "./NavLinks";
import { KolmeiaMark } from "./Logo";
import { LocaleSwitch } from "./LocaleSwitch";
import { Icon } from "./ui";

const GEAR =
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z";
const EXIT = "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9";
const ctl = "k-btn inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[12px] text-ink hover:bg-cold";

export async function Header({ workspaceName, role }: { workspaceName: string; role: Role }) {
  const t = await getT();
  return (
    <header className="border-b border-[#e3e6ec] bg-surface">
      <div className="mx-auto flex min-h-[68px] max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2">
        <Link href="/" className="k-link flex min-h-12 min-w-0 items-center gap-2.5 rounded-[12px] px-1.5 no-underline">
          <KolmeiaMark size={32} />
          <span className="truncate font-display text-2xl font-bold uppercase tracking-wide">{workspaceName}</span>
        </Link>
        <NavLinks variant="top" role={role} />
        <div className="flex items-center gap-1.5">
          <LocaleSwitch />
          <Link href={SETTINGS_HREF} aria-label={t.nav.settings} title={t.nav.settings} className={ctl}>
            <Icon d={GEAR} size={22} />
          </Link>
          <form action={signOut}>
            <button type="submit" className={`${ctl} px-3 font-mono text-sm uppercase`}>
              <Icon d={EXIT} size={18} />
              {t.signOut}
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
