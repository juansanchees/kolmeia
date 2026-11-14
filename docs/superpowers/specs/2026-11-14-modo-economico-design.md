# Modo econômico da Pesquisa (14/11/2026)

Objetivo: gastar bem menos com a API da Anthropic sem piorar a precisão dos leads. Código em `app/src/lib/ai/routing.ts`.

## Onde o dinheiro ia (antes)
| Etapa | Modelo | max_tokens | buscas / leituras por chamada | Reserva (pior caso) |
|---|---|---|---|---|
| Perguntas | Opus | 16k | - | 0,36 |
| Plano | Opus | 16k | - | 0,36 |
| Descobrir fontes | Sonnet | 12k | 6 / 3 | 0,97 |
| Juntar empresas (até 4 rodadas) | Sonnet | 16k | 8 / 6 | 1,35 |
| Checar (lote de 3) | Sonnet | 16k | 3 / 6 | 0,85 |
| Segunda passada (só Rigorosa) | Opus | 16k | 2 / 4 | 1,32 |

- Reserva = pior caso: (entrada base 8k + 20k por busca + 8k por página) x preço + saída máxima x preço + US$ 0,01 por busca, x2 (1 continuação pause_turn). Real fica 5 a 15x abaixo.
- O teto da pesquisa era checado contra a reserva cheia: com teto US$ 1, "Descobrir" (0,97) já não cabia depois de perguntas + plano -> "parcial, teto de custo" com 0 empresas.
- Medido hoje: perguntas US$ 0,0066/chamada; plano US$ 0,037/chamada. Busca/coleta/checagem: não medido ("?").
- Prompt caching: já ativo (system prompt com cache_control; continuações com breakpoint). Nada a mudar.

## Mudanças
1. **Chamada encolhe para caber no teto** (`fitWebToBudget`): se a reserva não cabe no que resta do teto, a chamada pede menos buscas/leituras (até 2+1), depois tira a continuação, depois 1+1. Só se nem isso cabe -> `run_cap`. A reserva continua sendo o pior caso da chamada que é enviada; tetos diários e do banco iguais. A IA recebe a linha de orçamento já reduzida.
2. **Sobra para checar**: Descobrir e Juntar deixam intocada a menor chamada de Checar (US$ 0,25), para o que foi achado ser checado.
3. **Rápida**: descobrir 3/2, juntar 5/3, checar 2/3 (buscas/leituras). Sem segunda passada (já era assim).
4. **Modelos**: Descobrir e Juntar -> Haiku 5.5 na Rápida e na Cuidadosa (Rigorosa continua Sonnet). Perguntas -> Sonnet.
5. Nota nos "limites da pesquisa" quando alguma chamada recebeu menos buscas para caber no teto.

## Depois
| Etapa | Rápida | Cuidadosa | Rigorosa |
|---|---|---|---|
| Perguntas | Sonnet (0,18) | Sonnet | Sonnet |
| Plano | Opus | Opus | Opus |
| Descobrir | Haiku 3/2 (0,09) | Haiku 6/3 (0,34) | Sonnet 6/3 (0,97) |
| Juntar | Haiku 5/3 (0,32) | Haiku 8/6 (0,46) | Sonnet 8/6 (1,35) |
| Checar | Sonnet 2/3 (0,65) | Sonnet 3/6 (0,85) | Sonnet 3/6 (0,85) |
| Segunda passada | - | - | Opus 2/4 (1,32) |

## Economia esperada (não medida = "?")
- Tokens de Descobrir/Juntar: Haiku custa US$ 0,10 / 0,50 por milhão (0,50 / 2,50 acima de 100k tokens de prompt) contra 2 / 10 do Sonnet: 75% a 95% a menos nessas etapas "?".
- Buscas (US$ 0,01 cada) não mudam de preço; na Rápida caem ~40% por chamada (juntar 8 -> 5) "?".
- Perguntas: ~50% a menos, mas é centavo (US$ 0,0066 -> ~0,003 "?").
- Pesquisa inteira: 40% a 60% a menos na Rápida/Cuidadosa "?" (depende de quanto Checar pesa; medir no ledger ai_calls).
- Ganho certo: teste de US$ 1 agora roda descobrir + juntar + checar (teste de motor com transporte falso).

## O que NÃO mudou (precisão depende disso)
- Checar (decide existe/ativa, obra, perfil, decisor) continua Sonnet em todos os rigores.
- Plano e segunda passada continuam Opus. Rigorosa não muda de modelo em nada.
- Toda URL citada continua tendo que vir das ferramentas; regras de evidência (P1/P9) iguais.
- Chamada encolhida acha menos, mas o que falta vira "?" (honesto), não um dado errado.

## Riscos / Juan decide
- Haiku 5.5 com web_search_20250305 + web_fetch_20250910 + saída estruturada: não testado ao vivo "?". Rodar 1 pesquisa Rápida de US$ 1 e olhar ai_calls.
- Juntar no Haiku também grava "obras sem construtora" e telefone (só com URL devolvida pela busca); vale conferir na 1ª rodada real.
- Teto padrão da Rápida continua US$ 2; pode baixar para US$ 1 se a rodada real confirmar.
