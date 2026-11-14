// Strings about the AI layer (shown wherever an AI call can fail or be refused).
export const ai = {
  notConfigured: "IA não configurada. Falta a chave da Anthropic no servidor (veja o README do produto). O resto do aplicativo funciona normalmente.",
  noAccess: "Seu acesso à IA ainda não foi liberado.",
  userCap: "Seu teto diário pessoal de gasto com IA foi atingido. A pesquisa ficou pausada; continue amanhã.",
  globalCap: "O teto diário de gasto com IA do sistema foi atingido. A pesquisa ficou pausada; continue amanhã.",
  runTime: "O tempo máximo desta pesquisa acabou. Ela parou e entregou o que já tinha, marcado como parcial.",
  dailyCap: "O teto diário de gasto com IA deste espaço foi atingido. A pesquisa ficou pausada; continue amanhã ou peça ao dono para subir o teto.",
  runCap: "O teto de custo desta pesquisa foi atingido. Ela parou e entregou o que já tinha, marcado como parcial.",
  qualifierDaily: "O teto do dia do Qualificador foi atingido. Ele volta sozinho à meia-noite (horário de Nova York).",
  leadCap: "Este lead atingiu o teto de gasto do Qualificador. Ele parou nele.",
  refused: "A IA recusou este pedido. Reescreva o pedido e tente de novo.",
  invalidOutput: "A IA devolveu uma resposta fora do formato esperado. Tentamos de novo no próximo passo.",
  truncated: "A resposta da IA foi cortada antes do fim. Tentamos de novo no próximo passo.",
  generic: "Falha ao falar com a IA. Tentamos de novo no próximo passo.",
  suggestion: "sugestão da IA",
} as const;
