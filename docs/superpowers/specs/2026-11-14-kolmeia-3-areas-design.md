# Kolmeia: 3 áreas (Agentes / Leads / Campanhas)

Data: 14/11/2026. Status: **Aguardando aprovação final do Juan**.

Convenção:
- "(decisão do Juan)" = ele decidiu. Não mudar sem perguntar.
- "(decisão do Claude — conferir)" = Claude decidiu no lugar; o Juan pode corrigir.
- "(proposta do Claude)" = sugestão ainda não fechada.
- "(construtor decide)" = detalhe técnico livre.
- "?" = não verificado.

Substitui, no ponto "envio", o `docs/gtm-harness.html` (que mandava enviar pelo Instantly). Agora o envio é da própria Kolmeia (decisão do Juan, 14/11).

O Juan aceita os riscos iniciais e quer tudo planejado com cuidado (decisão do Juan, 14/11).

## Decisões fechadas em 14/11

| # | Decisão | Quem |
|---|---|---|
| J1 | Agente de E-mail: o Juan aprova a SEQUÊNCIA + 3 e-mails de exemplo já montados, 1 vez por agente/campanha. Depois o agente envia o lote sozinho, sempre dentro dos portões do E2 (janela, limites diários, 50/24h, espaçamento, 1 pessoa por empresa). Qualquer edição na sequência exige nova aprovação. Passos de follow-up de sequência aprovada NÃO pedem nova aprovação | Juan |
| J2 | A closer tem LOGIN PRÓPRIO na Kolmeia: novo papel `closer` no workspace (hoje só existe `is_workspace_member`; passam a existir owner/sdr/closer). Vê só leads atribuídos/passados a ela, registra resultado de ligação, não cria agentes nem campanhas | Juan |
| J3 | Meta semanal de leads = baseline: a 1ª execução do Caçador é medida contra `data/gold/` (precisão e cobertura); a meta sai desse baseline. "Pronto quando" da F3 inclui gerar esse relatório | Juan |
| C1 | Pesquisas antigas ficam; os candidatos migram para LEADS; as execuções antigas aparecem como "pesquisa avulsa" no histórico do Caçador | Claude — conferir |
| C2 | O lead (nível workspace) é a verdade do status. `email_prospects` guarda só o status por campanha. Descartar lead ou marcar `do_not_call` para qualquer campanha ativa dele e bloqueia envio (conferido pelos portões de envio) | Claude — conferir |
| C3 | Um lead só pode estar em UMA campanha ativa por vez (garantido por constraint/trava). A regra do E2 "1 pessoa por empresa" vale entre campanhas | Claude — conferir |
| C4 | Execuções agendadas do Caçador trazem só empresas NOVAS (excluem quem já está em LEADS pela chave de duplicata). Prova com mais de 90 dias = "prova velha" na tela (reconferir é ação manual). Frequência padrão: semanal | Claude — conferir |
| C5 | Custo do Caçador agendado entra nos limites do workspace (`ai_limits`/`ai_access`, teto do workspace). Bateu o teto: o agente pausa sozinho e mostra aviso; nada roda além do teto | Claude — conferir |
| C6 | Máximo de 3 agentes Caçador ativos por workspace | Claude — conferir |
| C7 | Pesquisa agendada roda numa rota de cron SEPARADA (fora do tick de 60 s do relógio), com `maxDuration` próprio igual ao da etapa de pesquisa (300 s). O construtor confere se o plano da Vercel permite; se não, encolhe o tamanho da etapa. Execução sem sessão de usuário usa caminho `security definer` restrito ao workspace do agente (construtor desenha; deve manter as garantias de RLS e ser testado) | Claude — conferir |
| C8 | Status do lead inclui ganho/perdido | Claude — conferir |
| C9 | Antes da F3/F4 o construtor confere quais migrações (0005-0007) estão aplicadas no Supabase real e se o cron está ligado. Aplicar = Claude, com OK do Juan | Claude — conferir |
| C10 | Rotas antigas `/email/closer` e `/email/bloqueados` ganham redirecionamento permanente para os novos lugares | Claude — conferir |
| C11 | Multi-workspace: manter o que existe hoje; sem seletor novo neste projeto | Claude — conferir |
| C12 | Caixas de e-mail, domínio de envio, SPF/DKIM/DMARC, aquecimento e endereço físico do remetente (CAN-SPAM, `sender_profiles`) viram CHECKLIST no INÍCIO da F4. A F4 não envia de verdade até esse checklist estar feito com o Juan | Claude — conferir |
| C13 | "Passar pra closer" mora em LEADS | Claude — conferir |

## 1. Intenção e porquê

| Pergunta | Resposta |
|---|---|
| O que muda | O app hoje tem Pesquisa, Empresa e 5 telas de E-mail. Vira 3 áreas só. |
| Por quê | O Juan tem TDAH e é SDR. Quer abrir e saber na hora onde clicar. |
| Modelo mental | "Eu crio agentes. Agentes trazem leads. Leads viram campanha ou ligação." |
| Referência | Agentes do Instantly: galeria + criação por chat guiado (`docs/raw/re_instantly.md` seções 11.7, 14, 15). |

```
  AGENTES  ──acham/preparam──▶  LEADS  ──entram em──▶  CAMPANHAS DE E-MAIL
     │                            │
     └── Ligação: lista do dia ───┘──▶ closer liga e anota
```

## 2. Objetivos, não-objetivos, anti-objetivos

### 2.1 Objetivos
| # | Objetivo |
|---|---|
| 1 | Menu com exatamente 3 áreas: AGENTES, LEADS, CAMPANHAS DE E-MAIL (decisão do Juan) |
| 2 | Criar agente parecido com o Instantly: galeria + chat guiado (decisão do Juan) |
| 3 | Agentes servem para: achar leads, enviar e-mail, preparar ligações (decisão do Juan) |
| 4 | Campanhas enviam pela própria Kolmeia: o motor volta, E3 termina (decisão do Juan) |
| 5 | Ligação: por agora só manual, pela closer. Voz de IA fica pronta mas DESLIGADA (decisão do Juan) |
| 6 | Caçador roda em segundo plano, sem depender da aba aberta (proposta do Claude) |

### 2.2 Não-objetivos (agora)
- Ligação fria por IA (Vapi/ElevenLabs/Twilio).
- Agente de Respostas automáticas (tipo AI Reply Agent).
- Automações estilo "Custom Automations" do Instantly.
- Self-service para outros clientes / cobrança.
- Seletor de multi-workspace novo (C11).

### 2.3 Anti-objetivos (nunca)
| Anti-objetivo | Por quê |
|---|---|
| Complexidade, menu inchado | o pedido nº 1 do Juan é simplicidade |
| E-mail enviado sem aprovação humana da sequência (J1) | risco de marca e de compliance |
| Dado inventado (e-mail, nome, número) | regra R18: sem fonte, não existe |
| Ligação fria por IA antes de OK de advogado | TCPA (ver seção 9) |
| Escrever "pearchat" na tela do cliente NEAir HVAC | marca |

## 3. Restrições

| Tipo | Restrição |
|---|---|
| Stack | `kolmeia/app`: Next.js 16.4.5, Supabase/Postgres, RLS forçada por workspace (`is_workspace_member`; passa a ter papéis owner/sdr/closer, J2), testes vitest + PGlite |
| Banco | migrações 0001-0007 em `app/supabase/migrations`. Quais estão aplicadas no banco real: 0001-0004 sim; 0005-0007 ? (conferir antes da F3/F4, C9) |
| Reuso | reaproveitar telas e tabelas atuais; nada de reescrever o motor de pesquisa nem o de envio |
| Fontes | Caçador usa só `web_search`/`web_fetch` da Anthropic; LinkedIn bloqueado; URL não vista = rejeitada |
| Envio | portões do E2 valem sempre (seg-sex 9-18 fuso da campanha, limites diários, teto 50/24h, espaçamento 9+5 min, 1 pessoa por empresa, também entre campanhas) |
| Envio real | o relógio (0005) hoje só envia em ensaio (`dry_run`). Modo real = E6 do `docs/engenharia-envio.html`, só depois do checklist de caixas/domínio (C12) |
| Compliance | CAN-SPAM, consentimento de todas as partes para gravar em MA, Do Not Call residencial, nunca SMS frio, não raspar LinkedIn |
| Marca | nome do produto: Kolmeia. Tela do cliente: NEAir HVAC |
| Git | `kolmeia/` está fora do git; o E3 usa snapshots + `diff -ruN` (ledger `kolmeia/.superpowers/sdd/e3/progress.md`) |

## 4. Abordagens

| # | Caminho | Ordem | Prós | Contras |
|---|---|---|---|---|
| **1** | **Casca + Caçador** (escolhido) | casca 3 áreas → galeria → Caçador → E-mail → Ligação | o Juan vê o app novo logo; cada fase entrega algo usável; reaproveita telas | E3 fica parado até a F4 |
| 2 | Motor primeiro | terminar E3-E6 → depois a casca | envio real mais cedo | o Juan passa semanas sem ver mudança; menu confuso continua |
| 3 | Tudo junto | casca + agentes + motor em paralelo | parece mais rápido | muita coisa aberta ao mesmo tempo; difícil revisar; contra o "simples" |

Por que o 1 (decisão do Juan, "Caminho 1"): simplicidade visível primeiro; o Caçador é o que gera valor (leads com prova); o envio só faz sentido depois de ter leads bons.

## 5. Mapa de telas

### 5.1 Casca

```
┌──────────────────────────────────────────────────────────────┐
│ ⬡ Kolmeia   [ AGENTES ]  [ LEADS ]  [ CAMPANHAS DE E-MAIL ]  ⚙ │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   (conteúdo da área)                                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
 ⚙ = Configurações: Perfil da empresa, Caixas de e-mail,
     Bloqueados, Acesso à IA. FORA do menu principal (decisão do Juan).
```

No celular: as 3 áreas viram barra inferior (proposta do Claude).

Closer (J2): login próprio; vê só LEADS atribuídos a ela (e a lista de ligação). Sem AGENTES nem CAMPANHAS DE E-MAIL.

### 5.2 AGENTES

```
┌ AGENTES ─────────────────────────────── [ + Novo agente ] ┐
│ Meus agentes                                               │
│ ● Caçador Construtores Boston   rodando   12 leads hoje    │
│ ‖ E-mail Construtores           pausado   aguarda aprovação│
│ ‖ Ligação diária                pausado   8 na lista       │
└────────────────────────────────────────────────────────────┘
```

| O quê | Detalhe |
|---|---|
| Mostra | lista de agentes: nome, tipo, estado, métrica principal |
| Ações | Novo agente, Pausar/Retomar, Abrir, Duplicar (proposta do Claude), Arquivar |
| Reusa | `/pesquisa` (pedido + perguntas + plano), `lib/research/engine.ts`, `research_runs` |
| Novo | galeria, chat guiado, tabelas `agents` + `agent_runs` |
| Histórico do Caçador | inclui as pesquisas antigas como "pesquisa avulsa" (C1) |
| Limite | máx. 3 agentes Caçador ativos por workspace (C6) |
| Quem vê | owner/sdr. Closer não vê (J2) |

### 5.3 LEADS

```
┌ LEADS ──────────── [Busca] [Temperatura ▾] [Agente ▾] [Status ▾] ┐
│ Empresa          Temp   Abordagem  Status       Prova  Agente     │
│ Acme Builders    🔥     ligar      novo         3 ✓    Caçador A  │
│ Bay Developers   quente e-mail     em campanha  2 ✓    Caçador A  │
│ ...                                                              │
├── ao abrir um lead ──────────────────────────────────────────────┤
│ gancho · perguntar por (nome/cargo) · telefone · alvarás · nota  │
│ provas (url + trecho + data; "prova velha" se > 90 dias)         │
│ [Passar pra closer] [Pôr em campanha] [Pôr na lista de ligação]  │
│ [Descartar]                                                      │
└──────────────────────────────────────────────────────────────────┘
```

| O quê | Detalhe |
|---|---|
| Mostra | TODOS os leads do workspace, de todas as execuções e agentes, sem duplicar empresa (proposta do Claude). Closer vê só os atribuídos a ela (J2) |
| Ações | filtrar, abrir, Passar pra closer (C13), Pôr em campanha, Pôr na ligação, Descartar, CSV. Closer: só registrar ligação |
| Reusa | cartões/planilha de `pesquisa/[id]`, abas por abordagem (call/email/supplier_signup), `research_candidates`, `research_evidence`, `research_checks`, tela `email/closer` |
| Novo | tabela de lead no nível do workspace (seção 7), status, registro de ligação |

### 5.4 CAMPANHAS DE E-MAIL

```
┌ CAMPANHAS DE E-MAIL ──────────────────────── [ + Campanha ] ┐
│ Campanhas │ Caixa de entrada │ Respostas                    │
│ ⚠ Caixa joe@ desconectada   ⚠ bounce alto na campanha X     │
└─────────────────────────────────────────────────────────────┘
```

| O quê | Detalhe |
|---|---|
| Mostra | as telas atuais `email/campanhas`, `email/caixa`, `email/respostas` como sub-abas |
| Sai daqui | `email/closer` → vira ação em LEADS (C13); `email/bloqueados` → Configurações |
| Novo | faixa de avisos no topo (substitui o "Deliverability Agent", proposta do Claude) |
| Quem vê | owner/sdr. Closer não cria campanhas (J2) |

### 5.5 De-para das rotas atuais

| Hoje | Vai para |
|---|---|
| `/pesquisa`, `/pesquisa/[id]` | dentro de AGENTES (Caçador) e LEADS (resultado) |
| `/empresa` | ⚙ Configurações |
| `/email/campanhas`, `/caixa`, `/respostas` | CAMPANHAS DE E-MAIL |
| `/email/bloqueados` | ⚙ Configurações (redirecionamento permanente, C10) |
| `/email/closer` | LEADS, filtro "com a closer" (redirecionamento permanente, C10) |
| `/onboarding`, `/login`, `/u/[token]`, `/api/*` | sem mudança |

Nomes das URLs novas: construtor decide. Os redirecionamentos de `/email/closer` e `/email/bloqueados` são permanentes (C10).

## 6. Agentes

### 6.1 Tipos (proposta do Claude)

| Tipo | Faz | Entrega em | Por baixo |
|---|---|---|---|
| **Caçador** | acha empresas e confere com prova (existe/ativa, tem obra, cabe no perfil, decisor) | LEADS | o motor de pesquisa atual, vestido de agente, em segundo plano |
| **E-mail** | escreve a sequência para leads escolhidos; o Juan aprova a SEQUÊNCIA + 3 exemplos montados 1 vez (J1); depois envia o lote sozinho dentro dos portões | CAMPANHAS | `email_campaigns`, `email_messages`, `email_approvals` |
| **Ligação** | monta a lista do dia: telefone, gancho, roteiro curto, "perguntar por"; a closer liga e anota | LEADS (registro de ligação) | campos `phone`, `hook`, `ask_for_*`, `approach='call'` |

Fora: agente de Deliverability (vira avisos em Campanhas). Agente de Respostas: depois.

### 6.2 Galeria

```
┌ Novo agente ────────────────────────────────────────────────┐
│ [ Descreva o que você quer...                           ]  │
│                                                             │
│ ┌ Caçador ──────┐ ┌ E-mail ───────┐ ┌ Ligação ──────┐       │
│ │ acha leads    │ │ escreve e     │ │ lista do dia  │       │
│ │ com prova     │ │ envia após OK │ │ para a closer │       │
│ │   [Criar]     │ │   [Criar]     │ │   [Criar]     │       │
│ └───────────────┘ └───────────────┘ └───────────────┘       │
│ ┌ Ligação por IA ┐  em breve (desligado)                    │
└─────────────────────────────────────────────────────────────┘
```

Modelos prontos por nicho (ex.: "Construtores Boston/Cape", base em `data/gold/`): proposta do Claude, opcional na F2.

### 6.3 Criação por chat guiado

Igual ao Instantly: cada pergunta vem como cartão com 2-4 opções + "Outro" + "Responder no chat". Entre as perguntas, a IA mostra o que está fazendo ("lendo o site", "buscando concorrentes").

Caçador (proposta do Claude; reusa o fluxo atual da Pesquisa):

| # | Pergunta | Opções / origem |
|---|---|---|
| 1 | De onde puxo os dados da sua empresa? | Perfil salvo (`company_profiles`) · Um site · Descrever |
| 2 | Quem você quer achar? | 3 públicos sugeridos pelo perfil (ex.: construtores, administradoras, incorporadoras) |
| 3 | Onde? | região (como hoje) |
| 4 | 3-5 perguntas da IA | as perguntas que o Opus já faz hoje |
| 5 | Quanto rigor? | rápido · cuidadoso · rigoroso (como hoje) |
| 6 | Com que frequência? | uma vez · toda semana (padrão, C4) · todo dia |

E-mail: escolher leads (filtro de LEADS) → tom → nº de passos e espera → caixas → a IA escreve → o Juan revisa a sequência + 3 e-mails de exemplo montados e aprova (J1).
Ligação: escolher filtro (ex.: temperatura quente + abordagem ligar) → quantos por dia → quem liga (closer, com login próprio, J2).

### 6.4 Cartão de revisão (antes de criar)

```
┌ Revisão: Caçador Construtores Boston ───────────────────┐
│ Alvo: construtores residenciais multifamiliar           │
│ Região: Boston + Cape Cod                               │
│ Rigor: cuidadoso     Frequência: semanal                │
│ Fontes: web_search, web_fetch (sem LinkedIn)            │
│ Custo estimado: ?    Tempo: ?   (vem do plano atual)    │
│ Limites: máx. N empresas por execução                   │
│                    [Voltar]   [Criar agente (pausado)]  │
└─────────────────────────────────────────────────────────┘
```

Custo e tempo saem do cartão de plano que a Pesquisa já calcula. Não inventar valores.

### 6.5 Estados

```
 rascunho ──criar──▶ pausado ──Ligar──▶ rodando ──fim──▶ concluído
                       ▲                   │
                       └──── Pausar ───────┘
           (erro / limite de IA / caixa caiu ──▶ pausado + aviso)
```

- Todo agente nasce PAUSADO (proposta do Claude, igual ao Instantly).
- Agente de E-mail só envia depois da aprovação do Juan (sequência + 3 exemplos montados, 1 vez por agente/campanha). Depois, envia o lote sozinho, sempre dentro dos portões do E2. Editar a sequência volta para "aguarda aprovação". Follow-ups de sequência aprovada não pedem nova aprovação (J1).
- Teto de IA atingido: o agente Caçador pausa sozinho e mostra aviso (C5).
- "concluído" só para agente de execução única; agente com agenda volta a "pausado" ou fica "rodando".

### 6.6 Métricas por agente (proposta do Claude)

| Tipo | Métricas |
|---|---|
| Caçador | execuções, empresas achadas, conferidas (com prova), descartadas, custo de IA (`ai_calls`) |
| E-mail | rascunhos, aprovados, enviados, respostas, descadastros, bounces |
| Ligação | na lista, ligados, atendeu, reunião marcada |

### 6.7 Modelo de dados (esboço; nomes e detalhes: construtor decide)

```
agents
  id, workspace_id, type ('hunter'|'email'|'call'),
  name, status ('draft'|'paused'|'running'|'done'),
  config jsonb        -- respostas do chat (alvo, região, rigor, filtros...)
  schedule text       -- null | 'weekly' | 'daily' (forma: construtor decide)
  next_run_at, created_by, created_at, updated_at

agent_runs
  id, workspace_id, agent_id,
  research_run_id   -> research_runs (Caçador)
  campaign_id       -> email_campaigns (E-mail)
  started_at, finished_at, outcome, counts jsonb
```

- RLS forçada por workspace, como as outras tabelas.
- Papéis no workspace: owner / sdr / closer (J2). Hoje só existe `is_workspace_member`; o construtor desenha a tabela/coluna de papel e as políticas (closer: leitura só dos leads atribuídos a ela, escrita só no registro de ligação).
- Ligação/E-mail podem nem precisar de `agent_runs`: construtor decide.

### 6.8 Caçador em segundo plano

Hoje: `RunDriver` (no navegador) chama `POST /api/research/[id]/advance`. Fechou a aba, parou.

```
pg_cron ─5 min─▶ /api/scheduler/tick          ─▶ (já existe: envio, 60 s)
pg_cron ───────▶ /api/.../research-cron (novo) ─▶ avança 1 etapa de 1-N
                  rota SEPARADA, maxDuration 300 s    research_runs "rodando"
```

| Regra | Detalhe |
|---|---|
| Rota separada (C7) | pesquisa agendada NÃO roda dentro do tick de 60 s. Rota de cron própria, `maxDuration` = 300 s (igual à etapa de pesquisa). O construtor confere se o plano da Vercel permite; se não, encolhe o tamanho da etapa |
| Sem sessão de usuário (C7) | caminho `security definer` restrito ao workspace do agente; construtor desenha; deve manter as garantias de RLS e ter teste |
| Etapas | cada chamada avança uma etapa curta (`discover_sources` → `collect` → `verify` → `second_pass` → `finalize`) e salva |
| Agenda | a rota cria a execução quando `next_run_at` passou. Padrão semanal (C4) |
| Só novos (C4) | execução agendada exclui empresas já em LEADS (chave de duplicata) |
| Custo (C5) | conta nos limites do workspace (`ai_limits`/`ai_access`); bateu o teto, o agente pausa e avisa; nada roda além do teto |
| Limite de agentes (C6) | máx. 3 Caçadores ativos por workspace |
| Relógio | reusar o do E1 (token conferido no banco, lease de 1 por vez) |
| Tela | continua podendo mostrar o progresso (só leitura) |

## 7. Leads

### 7.1 Modelo unificado (proposta do Claude)

Hoje cada `research_candidates` pertence a uma execução (`unique (run_id, name_key)`). A mesma empresa pode aparecer em várias execuções.

```
research_candidates (por execução)  ──N:1──▶  leads (por workspace)
                                              uma linha por empresa
```

| Campo de `leads` | Origem |
|---|---|
| `id`, `workspace_id` | novo |
| `company_key` | chave de duplicata (abaixo) |
| `best_candidate_id` | o candidato mais recente/mais conferido (regra: construtor decide) |
| `status` | 7.2 |
| `origin` | agente/execução que trouxe primeiro (o CLAUDE.md pede campo `origem` em todo lead); pesquisas antigas = "pesquisa avulsa" (C1) |
| `owner` | SDR ou closer (usuário com login, J2) |
| `closer_brief`, `handed_off_at` | hoje em `email_prospects`; passa a valer no lead |
| `first_seen_at`, `last_seen_at` | novo |

Chave de duplicata: a mesma regra de `lib/research/dedupe.ts` (nome normalizado OU domínio do site OU últimos 10 dígitos do telefone). Tabela nova vs. view sobre `research_candidates`: construtor decide.

Provas continuam em `research_evidence`/`research_checks`, ligadas ao candidato. O lead mostra as provas de todos os candidatos dele. Prova com mais de 90 dias = "prova velha"; reconferir é ação manual (C4).

Migração (C1): as pesquisas antigas ficam; os candidatos delas migram para LEADS; as execuções aparecem como "pesquisa avulsa" no histórico do Caçador.

### 7.2 Status

```
novo ─▶ em campanha ─▶ respondeu ─▶ com a closer ─▶ reunião ─▶ ganho
  │         │                            │                   └▶ perdido
  └─▶ na lista de ligação ───────────────┘
  └─▶ descartado
```

| Regra | Detalhe |
|---|---|
| Ganho/perdido | entram agora (C8): o dono quer funil por origem |
| Fonte da verdade (C2) | o status do LEAD (workspace) manda. `email_prospects` guarda só o status por campanha |
| Descartar / `do_not_call` (C2) | para qualquer campanha ativa do lead e bloqueia envio (os portões de envio conferem) |
| Campanha única (C3) | um lead só em UMA campanha ativa por vez (constraint/trava); "1 pessoa por empresa" do E2 vale entre campanhas |

Nomes exatos dos status: construtor decide.

### 7.3 Passar pra closer (C13)

- Botão em LEADS (sai de `email/closer`).
- Leva o `closer_brief` que já existe (quem, o que disse, próximo passo, URLs de prova).
- Funciona mesmo para lead que nunca recebeu e-mail (veio da ligação).
- Atribui o lead ao login da closer (J2); a partir daí ela o vê.

### 7.4 Registro de ligação manual (proposta do Claude; a closer usa a Kolmeia com login próprio, J2)

| Campo | Tipo |
|---|---|
| `lead_id`, `workspace_id` | ref |
| `called_by` | usuário (closer) |
| `called_at` | data/hora |
| `phone_used` | texto (o do lead, com fonte) |
| `outcome` | `no_answer` · `voicemail` · `gatekeeper` · `talked` · `meeting_booked` · `not_interested` · `wrong_number` · `do_not_call` |
| `spoke_to` | nome/cargo |
| `notes` | texto curto |
| `next_step`, `next_step_at` | texto + data |
| `recorded` | sempre `false` nesta fase (gravar exige consentimento de todas as partes em MA) |

`do_not_call` bloqueia o lead para ligações futuras (como `suppressions` faz no e-mail) e, por C2, também para campanhas.

## 8. Campanhas de e-mail

| Item | O que muda |
|---|---|
| Telas | as mesmas de hoje, como sub-abas |
| Entrada | hoje a campanha recebe uma `research_list`. Passa a receber também uma seleção de LEADS (proposta do Claude; ponte via `research_lists` é aceitável). Lead em campanha ativa não entra em outra (C3) |
| R18 | continua: sem e-mail inventado; `source_url` obrigatório |
| Aprovação (J1) | o Juan aprova a SEQUÊNCIA + 3 e-mails de exemplo montados, 1 vez por agente/campanha (`email_approvals`). Depois o agente envia o lote sozinho, sempre dentro dos portões do E2. Edição na sequência = nova aprovação. Follow-ups de sequência aprovada não pedem nova aprovação |
| Portões | janela, limites diários, 50/24h, espaçamento, 1 pessoa por empresa (entre campanhas) e bloqueio por lead descartado/`do_not_call` (C2) |
| Checklist antes de enviar de verdade (C12) | no INÍCIO da F4, com o Juan: caixas de e-mail reais, domínio de envio, SPF/DKIM/DMARC, aquecimento, endereço físico do remetente (CAN-SPAM, `sender_profiles`). Sem o checklist pronto, F4 só roda em ensaio |
| Motor | retomar E3: revisar a Task 6 (`task-6-diff.txt`), fazer a Task 7 (README + check completo), revisão final. Ledger: `kolmeia/.superpowers/sdd/e3/progress.md`; plano: `kolmeia/docs/superpowers/plans/2026-11-14-e3-rodizio-de-caixas.md` |
| Depois do E3 | E4 saúde da caixa, E5 respostas no relógio, E6 primeiro envio real (`docs/engenharia-envio.html`) |
| Avisos | caixa desconectada, bounce alto, campanha sem leads, limite do dia atingido (proposta do Claude) |

## 9. Compliance (não é aconselhamento jurídico)

| Canal | Regra |
|---|---|
| E-mail frio B2B | CAN-SPAM: nome real, endereço físico, link de descadastro em todo e-mail |
| Ligação manual | empresas: OK; residencial: checar Do Not Call nacional |
| Gravação | MA exige consentimento de TODAS as partes |
| SMS | nunca SMS frio |
| LinkedIn | não raspar |
| Voz de IA | FCC (fev/2024): voz gerada por IA = "voz artificial" na TCPA → consentimento prévio para ligar para celular; multas de US$ 500-1.500 por ligação. Ligação fria por IA só depois de revisão de advogado |

Estado da voz: assistentes de teste no ElevenLabs + Vapi com o roteiro da Air HVAC (`docs/voz/agente-teste-air-hvac.md`). Número grátis do Vapi só recebe; console do Twilio não carregou; sem número de saída. Fica DESLIGADO.

## 10. Fases

| Fase | O quê | Pronto quando |
|---|---|---|
| **F1 Casca** | menu de 3 áreas + ⚙; telas atuais movidas; redirecionamentos permanentes (inclui `/email/closer` e `/email/bloqueados`, C10) | o Juan abre o app e vê só AGENTES / LEADS / CAMPANHAS; todas as telas atuais acessíveis; nenhum teste quebra; nenhuma tela do cliente diz "pearchat" |
| **F2 Galeria + criação** | tabela `agents`; galeria; chat guiado do Caçador; cartão de revisão; estados; papéis owner/sdr/closer no workspace (J2) | o Juan cria um Caçador pelo chat, vê o cartão de revisão e o agente aparece PAUSADO na lista |
| **F3 Caçador em segundo plano** | PRÉ: conferir migrações 0005-0007 no Supabase real e cron ligado (C9). Rota de cron separada (C7); agenda; tela LEADS unificada com duplicata; migração das pesquisas antigas (C1); só empresas novas, prova velha, teto de IA, máx. 3 agentes (C4-C6) | o Juan liga o Caçador, fecha a aba, volta depois e os leads estão em LEADS, sem empresa repetida, com prova; E sai o relatório de baseline da 1ª execução contra `data/gold/` (precisão e cobertura), que define a meta semanal de leads (J3) |
| **F4 Agente E-mail + envio real** | INÍCIO: checklist de caixas/domínio/SPF-DKIM-DMARC/aquecimento/endereço físico com o Juan (C12) e conferência das migrações (C9). Depois: terminar E3 (Task 6 review, Task 7, revisão final); E4-E6; agente E-mail com aprovação de sequência + 3 exemplos (J1); trava de campanha única (C3); status do lead manda (C2); avisos | checklist feito; 1 campanha pequena real: sequência aprovada pelo Juan, lote enviado pelo relógio dentro dos portões, follow-up pela mesma caixa; (E6: 10 e-mails reais entregues e anotados) |
| **F5 Agente Ligação manual** | lista do dia; tela de ligação; registro; login da closer (J2); Passar pra closer em LEADS (C13) | a closer entra com o próprio login, vê só os leads dela, liga, anota o resultado em menos de 1 min por ligação (?) e o status do lead muda |

F4 pode começar em paralelo com F3 se forem pessoas/agentes diferentes (arquivos diferentes): construtor decide. O checklist da C12 não bloqueia o código, só o envio real.

## 11. O que fica para o construtor decidir

- Nomes de rotas novas (os redirecionamentos de `/email/closer` e `/email/bloqueados` são permanentes, C10).
- `leads` como tabela vs. view; regra do `best_candidate_id`.
- Forma de `schedule` (texto, cron, enum) e `next_run_at`.
- Desenho do caminho `security definer` por workspace para pesquisa sem sessão (C7), mantendo RLS, com teste.
- Se o plano da Vercel aceita `maxDuration` 300 s na rota de cron; senão, tamanho menor da etapa (C7).
- Papéis owner/sdr/closer: tabela vs. coluna em `workspace_members`; políticas RLS do closer (J2).
- Constraint da campanha única por lead (C3).
- Nomes exatos dos status do lead.
- Se Ligação/E-mail precisam de `agent_runs`.
- Ponte campanha ← LEADS (direto ou via `research_lists`).
- Componentes do chat guiado (reusar o de perguntas da Pesquisa ou novo).
- Visual: seguir `kolmeia/design-telas/Main.dc.html`.

## 12. Perguntas em aberto

Nenhuma. Todas as perguntas anteriores foram resolvidas em 14/11:

| # | Pergunta antiga | Resolvida por |
|---|---|---|
| 1 | Os 3 tipos de agente estão certos? | objetivo 3 (decisão do Juan): achar leads, enviar e-mail, preparar ligações |
| 2 | "Passar pra closer" vai para LEADS? | C13 |
| 3 | Frequência padrão do Caçador | C4 (semanal) |
| 4 | Meta de leads por semana | J3 (baseline contra `data/gold/`) |
| 5 | A closer anota na Kolmeia? | J2 (login próprio, papel `closer`) |
| 6 | Quais caixas entram no 1º envio real? | C12 (checklist no início da F4, com o Juan) |
| 7 | Ganho/perdido entram no status? | C8 (sim) |

Pendente só: aprovação final do Juan sobre este documento.
