import { t } from "@/messages/pt";
import type { Role } from "@/lib/roles";

export type NavItem = { href: string; label: string };

/** The longest href that matches the pathname (exact, or followed by a slash); null when none does. */
export function activeHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if ((pathname === href || pathname.startsWith(href + "/")) && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

export const SETTINGS_TABS: readonly NavItem[] = [
  { href: "/configuracoes/empresa", label: t.settings.nav.company },
  { href: "/configuracoes/caixas", label: t.settings.nav.mailboxes },
  { href: "/configuracoes/bloqueados", label: t.settings.nav.blocked },
  { href: "/configuracoes/fontes", label: t.settings.nav.sources },
];

/** The closer sees only Empresa: mailboxes, blocked list and Fontes conectadas are for owner and sdr (RLS, 0017). Equipe is for the owner only (0020). */
export function settingsTabsFor(role: Role): readonly NavItem[] {
  if (role === "closer") return SETTINGS_TABS.filter((i) => i.href === "/configuracoes/empresa");
  return role === "owner" ? [...SETTINGS_TABS, { href: "/configuracoes/equipe", label: t.team.tab }] : SETTINGS_TABS;
}

export const LEADS_TABS: readonly NavItem[] = [
  { href: "/leads", label: t.leads.nav.all },
  { href: "/leads/closer", label: t.leads.nav.closer },
];

/** Cobertura is for owner and sdr; the closer keeps the two tabs above. */
export function leadsTabsFor(role: Role): readonly NavItem[] {
  return role === "closer" ? LEADS_TABS : [...LEADS_TABS, { href: "/leads/cobertura", label: t.coverage.tab }];
}

export const CAMPAIGN_TABS: readonly NavItem[] = [
  { href: "/campanhas", label: t.email.nav.campaigns },
  { href: "/campanhas/respostas", label: t.email.nav.replies },
];

export const SETTINGS_HREF = "/configuracoes";

export const MAIN_AREAS: readonly NavItem[] = [
  { href: "/agentes", label: t.nav.agents },
  { href: "/leads", label: t.nav.leads },
  { href: "/campanhas", label: t.nav.campaigns },
];

/** The closer sees only LEADS; owner and sdr see every area. */
export function areasFor(role: Role): readonly NavItem[] {
  return role === "closer" ? MAIN_AREAS.filter((a) => a.href === "/leads") : MAIN_AREAS;
}
