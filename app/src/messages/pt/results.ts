// Leads > Resultados: the leads grouped by the result of their last registered contact.
export const results = {
  tab: "Resultados",
  title: "Resultados dos contatos",
  subtitle: "Cada lead aparece uma vez, no resultado do último contato registrado.",
  tabs: {
    label: "Resultado",
    no_answer: "Não atendeu",
    meeting_booked: "Quer reunião",
    call_back: "Ligar depois",
    not_interested: "Sem interesse",
    do_not_call: "Não ligar mais",
    voicemail: "Caixa postal",
    wrong_number: "Número errado",
  },
  empty: "Nenhum contato registrado ainda. Registre pelo botão Registrar contato no lead.",
  emptyGroup: "Nenhum lead neste resultado.",
  cols: { lead: "Empresa", result: "Resultado", note: "Nota", by: "Quem", when: "Quando" },
  callBack: "Ligar em",
  open: "Abrir",
  unknown: "—",
} as const;
