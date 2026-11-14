const settings = {
  title: "Configurações",
  nav: { label: "Seções de Configurações", company: "Sua empresa", mailboxes: "Caixas de e-mail", blocked: "Bloqueados" },
} as const;

const leads = {
  title: "Leads",
  subtitle: "Empresas achadas pelas pesquisas, com prova.",
  nav: { label: "Seções de Leads", all: "Todos", closer: "Com a closer" },
  soon: "Em breve: todos os leads numa lista só, sem empresa repetida. Por enquanto, abra o resultado de cada pesquisa:",
  none: "Nenhuma pesquisa pronta ainda.",
  start: "Fazer uma pesquisa",
} as const;

export const areas = { leads, settings } as const;
