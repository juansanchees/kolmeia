import type { Messages } from "@/lib/i18n";
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

export const settingsTabs = (t: Messages): readonly NavItem[] => [
  { href: "/configuracoes/empresa", label: t.settings.nav.company },
  { href: "/configuracoes/caixas", label: t.settings.nav.mailboxes },
  { href: "/configuracoes/bloqueados", label: t.settings.nav.blocked },
  { href: "/configuracoes/fontes", label: t.settings.nav.sources },
];

/** The closer sees only Empresa: mailboxes, blocked list and Fontes conectadas are for owner and sdr (RLS, 0017). Equipe is for the owner only (0020). */
export function settingsTabsFor(role: Role, t: Messages): readonly NavItem[] {
  const tabs = settingsTabs(t);
  if (role === "closer") return tabs.filter((i) => i.href === "/configuracoes/empresa");
  return role === "owner" ? [...tabs, { href: "/configuracoes/equipe", label: t.team.tab }] : tabs;
}

/** Every role: Todos, Ligar, Tarefas and Resultados (the closer sees her own call list and tasks there). */
export const leadsTabs = (t: Messages): readonly NavItem[] => [
  { href: "/leads", label: t.leads.nav.all },
  { href: "/leads/ligar", label: t.calls.tab },
  { href: "/leads/tarefas", label: t.leads.nav.tasks },
  { href: "/leads/resultados", label: t.results.tab },
];

/** Listas, Funil, Cobertura and Perfil are for owner and sdr; the closer keeps the tabs above. */
export function leadsTabsFor(role: Role, t: Messages): readonly NavItem[] {
  return role === "closer"
    ? leadsTabs(t)
    : [
        ...leadsTabs(t),
        { href: "/leads/listas", label: t.leads.nav.lists },
        { href: "/leads/funil", label: t.funnel.tab },
        { href: "/leads/cobertura", label: t.coverage.tab },
        { href: "/leads/perfil", label: t.profile.results.tab },
      ];
}

export const campaignTabs = (t: Messages): readonly NavItem[] => [
  { href: "/campanhas", label: t.email.nav.campaigns },
  { href: "/campanhas/respostas", label: t.email.nav.replies },
];

export const SETTINGS_HREF = "/configuracoes";

export const HOME_HREF = "/inicio";

export const mainAreas = (t: Messages): readonly NavItem[] => [
  { href: HOME_HREF, label: t.home.nav },
  { href: "/agentes", label: t.nav.agents },
  { href: "/leads", label: t.nav.leads },
  { href: "/campanhas", label: t.nav.campaigns },
];

/** The closer sees only Início and LEADS; owner and sdr see every area. */
export function areasFor(role: Role, t: Messages): readonly NavItem[] {
  const areas = mainAreas(t);
  return role === "closer" ? areas.filter((a) => a.href === HOME_HREF || a.href === "/leads") : areas;
}
