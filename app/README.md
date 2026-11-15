# product

Ferramenta de prospecção para empresas de serviço (primeiro nicho: HVAC nos EUA). Três áreas: **Agentes**, **Leads** e **Campanhas de e-mail**; ⚙ **Configurações** (Sua empresa, Caixas de e-mail, Bloqueados). Esta pasta é independente de `site/` e `pipeline/`. Estado atual: Fase 0, Pesquisa (fases 1 a 3) e E-mail (fases 4 e 5); ver `docs/mvp/fase-0.md`, `docs/mvp/fase-1-3-pesquisa.md` e `docs/mvp/fase-4-email.md`.

## Rodar
```
npm ci
npm run dev        # desenvolvimento
npm run check      # typecheck + lint + test + build + checagem do bundle (o mesmo do CI)
```

## Criar um Caçador (F2)
1. **Agentes** → **+ Novo agente** → **Caçador**.
2. Responda as 3 perguntas (empresa, quem, onde). A IA faz as perguntas dela e monta o plano.
3. Escolha rigor e frequência, revise o cartão e clique em **Criar agente (pausado)**.

O agente nasce **pausado** e ainda **não roda** (rodar sozinho = próxima fase; e-mail e ligação vêm depois). Sem chave da IA, o rascunho fica salvo e dá para **Continuar** depois. A closer vê só **Leads**; Agentes e Campanhas são do dono e do SDR.
**Antes de publicar esta versão, aplique a migração `0008_agents.sql`** (depende de 0001 a 0004).

## Variáveis (as únicas quatro)
Copie `.env.example` para `.env.local` e preencha:

| Variável | O quê |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto Supabase do produto |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave pública (anon) |
| `ANTHROPIC_API_KEY` | chave da API da Anthropic. **Só no servidor**: lida apenas em `src/lib/ai/config.ts` (que importa `server-only`); um teste e a checagem do bundle garantem que ela não vai para o navegador |
| `MAILBOX_ENC_KEY` | base64 de 32 bytes aleatórios (`openssl rand -base64 32`). **Só no servidor**: lida apenas em `src/lib/email/config.ts`; cifra as senhas de app das caixas (AES-256-GCM). Trocar a chave invalida as caixas salvas (é só conectar de novo) |

Não existe chave de administrador aqui (regra R14). Com as do Supabase vazias, o app compila e mostra "Banco não configurado". Sem `ANTHROPIC_API_KEY`, a Pesquisa mostra "IA não configurada" e o resto funciona (no E-mail, os rascunhos podem ser escritos com o modelo padrão, sem IA). Sem `MAILBOX_ENC_KEY`, o E-mail não conecta caixas; o resto funciona.

**Busca na web**: a Pesquisa usa as ferramentas de servidor `web_search` e `web_fetch` da Anthropic. A busca na web precisa estar **ligada para a organização na Console da Anthropic** (configurações de privacidade/ferramentas); sem isso as chamadas falham. LinkedIn é bloqueado nas duas ferramentas.

## Custos de IA (regras R16 e P6)
- Toda chamada passa por `src/lib/ai/gateway.ts` e vira uma linha em `ai_calls` (modelo, versão do prompt, tokens, buscas, custo estimado).
- Teto por pesquisa: escolhido no plano (padrão US$ 1 / 2 / 4 por rigor; máximo US$ 10). Ao bater, a pesquisa termina como **parcial**.
- Teto por dia e por espaço: `workspace_settings.ai_daily_cap_usd` (padrão US$ 10; só o dono muda; 0 a 100). Ao bater, a busca pausa.
- Preços em `src/lib/ai/pricing.ts` (lidos em platform.claude.com em 10/11/2026). O custo é estimativa pelo preço de tabela.

## Testes sem banco real e sem IA real
Os testes de banco usam **PGlite** (Postgres em WASM, roda no Node). O teste cria os papéis `anon`, `authenticated`, `service_role` e `auth.uid()` como o Supabase faz, aplica todas as migrações de `supabase/migrations/` em ordem, sem alterações, e roda as consultas como cada usuário (papel não superusuário), então a RLS é aplicada de verdade. Nada chama um Supabase real.

A IA é trocada por um cliente falso (`tests/engine/fake-ai.ts`): **nenhum teste chama a rede**. O teste da máquina de estados (`tests/engine/engine.test.ts`) roda a pesquisa inteira contra o PGlite como o usuário logado.

## O que o dono precisa fazer depois
1. Criar um projeto Supabase **separado** para o produto (não o do site).
2. Aplicar as migrações de `supabase/migrations/` em ordem, de `0001` a `0026` (SQL Editor, como o papel `postgres`; não há `0012` nesta pasta, e ela nunca é aplicada). A `0007_rotation.sql` tem que estar aplicada **antes** de publicar esta versão do app. Para a ordem do F4 (0018 a 0026), veja **F4: Agente E-mail > Ordem de publicação**.
3. Em Authentication, **manter a confirmação de e-mail LIGADA** (desligada, o cadastro revela se um e-mail já existe).
4. Colar as duas chaves públicas em `.env.local` (e na Vercel, quando houver deploy).
5. Para a Pesquisa: criar uma chave na Console da Anthropic, ligar a busca na web para a organização, e colar em `ANTHROPIC_API_KEY` (só servidor; na Vercel, sem o prefixo `NEXT_PUBLIC_`).
6. Para o E-mail: `MAILBOX_ENC_KEY` no servidor; em ⚙ Configurações > Caixas de e-mail, preencher razão social, **endereço físico** e nome; conectar a caixa Gmail com uma senha de app; testar em **ensaio** antes de ligar o envio real (só o dono liga).

## Segurança: regras para lembrar
- **Antes de lançar:** adicionar CAPTCHA ou limite de tentativas no app. O login roda em server actions, então o Supabase vê um IP só (o do servidor) e o limite dele não protege por usuário.
- **Banco:** depois que uma migração for aplicada em qualquer lugar, mudanças de schema vão em migrações novas e numeradas (`0003_...`). Não editar `0001` nem `0002` depois de aplicadas.
- **Pesquisa sem trabalhador em segundo plano:** a busca anda só com a tela aberta (um passo por chamada de `POST /api/research/[id]/advance`, com trava no banco). Tela fechada = pesquisa parada, sem perda.
- **Conteúdo da web é dado, nunca instrução (R15):** só os campos que passam no schema zod são gravados, com limite de tamanho, URLs só http(s) e nunca LinkedIn (também barrado no banco).
- **Dono único:** todo espaço precisa de pelo menos 1 `owner` (trigger no banco). O único dono não pode se rebaixar, sair, nem ter a conta apagada no Supabase Auth. Antes: passar a posse para outro membro ou apagar o espaço.
- Clientes não inserem membros nem espaços; só o RPC `create_workspace` cria espaço. Convite virá como RPC de convidar e aceitar.

## E-mail: regras para lembrar
- **Nada sai sem aprovação humana (R1)**: a aprovação é carimbada pelo banco (quem e quando); editar um e-mail aprovado tira a aprovação. A IA só rascunha e rotula.
- **Envio real só com a tela aberta**: `POST /api/email/campaigns/[id]/send` envia no máximo **um** e-mail por chamada, por `claim_next_email()`, que aplica horário e fuso da campanha, limite do dia por caixa e por campanha, intervalo de 9 min + até 5 min sorteados, 1 pessoa por empresa por dia (ver "Portões de envio (E2)"), lista de bloqueio e rodapé obrigatório **dentro do banco**. Os e-mails 2 e 3 vencem por data, mas só saem quando alguém abrir a campanha e tocar "Enviar os de hoje". O Relógio (abaixo) só mexe em campanhas em ensaio.
- **Ensaio por padrão**: toda campanha nasce em ensaio (nenhuma conexão SMTP). Envio real: só o dono, com caixa testada e endereço físico salvo.
- **Só Gmail / Google Workspace** (hosts fixos `smtp.gmail.com:465` e `imap.gmail.com:993`), com senha de app.
- **Descadastro público** em `/u/[token]` (inglês) e `/api/unsubscribe/[token]` (um clique, RFC 8058); usa só a chave pública e um RPC estreito (`unsubscribe_by_token`).
- **Senha da caixa**: cifrada no servidor, guardada sem permissão de leitura para clientes, decifrada só na memória para um login; nunca vai ao navegador nem ao log.

## Relógio (E1)
- **O que faz:** a cada 5 minutos o `pg_cron` do Supabase chama `POST /api/scheduler/tick`, sem ninguém logado. O tick pega os e-mails **aprovados e vencidos** de campanhas **em ensaio** e roda o mesmo passo de envio (`sendStep`), no máximo 1 por campanha e 10 por tick. Cada tick grava uma linha em `scheduler_runs` (hora, contagens, código curto de erro; nada de endereço, assunto ou texto).
- **Só ensaio, só envio:** o banco recusa qualquer campanha que não esteja em ensaio e o transporte SMTP do relógio sempre falha. Não lê respostas, não usa senha da caixa, não chama IA. Envio real continua só com a tela aberta.
- **Credencial:** um token de 64 caracteres hex, conferido pelo banco (guarda só o hash em `scheduler_state`). O app não tem variável nova. Sem token configurado, o relógio está desligado.
- **Para ligar (uma vez, o dono):** aplicar as migrações `0005_scheduler.sql`, `0006_gates.sql` e `0007_rotation.sql` e colar `supabase/manual/scheduler_cron.sql` no editor SQL do Supabase, trocando `<APP_URL>` e `<TOKEN>`. O mesmo arquivo tem os comandos para parar o relógio e trocar o token.

## Portões de envio (E2)
Valem para os e-mails da sequência, no clique e no relógio, em ensaio e em envio real.
- **Respostas escritas por uma pessoa** ficam de fora da janela de horário, do limite da campanha e da regra de empresa. Mas **contam** no contador diário da campanha e ainda exigem caixa verificada e perfil de remetente completo; obedecem ao limite e ao intervalo da caixa.
- **Horário**: segunda a sexta, 09:00 às 18:00, no fuso da campanha (padrão America/New_York). Fora disso a tela diz quando volta (ex.: "segunda às 09:00").
- **Limite do dia**: o dia zera à meia-noite do fuso da campanha. Por caixa: `daily_limit` da caixa, com teto de 50 por endereço. Por campanha: `daily_limit` da campanha (padrão 30). Vale o menor. Quando bate, a tela mostra o próximo horário de envio de verdade (próxima janela aberta), não a meia-noite.
- **Teto rolante de 50 por endereço**: além do dia de calendário, nunca mais de 50 envios do mesmo endereço em 24 horas corridas (duas campanhas em fusos distantes na mesma caixa não passam disso).
- **Intervalo**: 9 min + 0 a 5 min sorteados entre dois envios da mesma caixa.
- **1 pessoa por empresa por dia**, por espaço. "Empresa" = a empresa da pesquisa; sem ela, o domínio do e-mail (exceto e-mail pessoal, como gmail ou comcast); sem isso, o nome da empresa. Ensaio e envio real são contados separados. A regra lê o registro de envios (que ninguém apaga): falha ou envio interrompido não bloqueia a empresa. Quem é bloqueado é pulado e espera o dia seguinte, sem travar a fila.
- Esses valores ainda não se editam pela tela. A página da campanha mostra a regra em uma linha.
- **Antes de publicar** esta versão do app, aplicar `0006_gates.sql`: a página da campanha lê as colunas novas.

## Rodízio de caixas (E3)
- **Várias caixas por campanha**: na página da campanha, marque de 1 a 10 caixas deste espaço. Cada caixa mostra quantos e-mails saíram dela hoje.
- **Quem recebe o 1º e-mail**: a caixa que menos enviou hoje (desde a meia-noite do fuso da campanha), entre as que podem enviar agora. Em envio real, só caixas verificadas. Caixa no limite do dia, no teto de 50 em 24 h ou no intervalo é pulada.
- **Caixa fixa por pessoa**: o 2º e 3º e-mails e as respostas saem sempre pela caixa do 1º e-mail, na mesma conversa. Se essa caixa for desmarcada, apagada, ou não estiver verificada em envio real, a pessoa **espera** (nunca muda de caixa). Marcar a caixa de novo faz ela voltar.
- **Limites**: o limite da campanha soma todas as caixas dela; o limite, o teto e o intervalo de cada caixa valem por endereço, somando todas as campanhas.
- **Envio real**: precisa de pelo menos uma caixa verificada. Ao passar de ensaio para real, as caixas escolhidas no ensaio são esquecidas. Trocar a primeira caixa de uma campanha em envio real volta a campanha para ensaio (como antes).
- `email_campaigns.mailbox_id` continua existindo e quer dizer "primeira caixa da campanha"; o banco mantém as duas coisas em sincronia.
- **Antes de publicar** esta versão do app, aplicar `0007_rotation.sql`: o envio lê a caixa gravada em cada e-mail.

## Leads (F3a)
- **LEADS** = todas as empresas que as pesquisas acharam, **sem repetir** (uma linha por empresa, por espaço). Mesma empresa escrita diferente (nome, site, telefone) vira um lead só.
- As pesquisas antigas já viraram leads, com origem **"Pesquisa avulsa"**. Lead de agente mostra o nome do agente.
- **"prova velha"**: prova (ou "achada em") vista há mais de 90 dias. Só um aviso; reconferir ainda é manual.
- A **closer** só vê leads passados para ela (isso chega na F5); até lá a tela dela fica vazia. Ela não abre telas de pesquisa (`/agentes/pesquisa/...` volta para LEADS).
- **Antes de publicar** esta versão do app, aplicar `0009_leads.sql` (depende de 0001-0008).

## Caçador em segundo plano (F3b)
- **Ligar / Pausar**: no agente, "Ligar" põe o Caçador para trabalhar sozinho na frequência escolhida, mesmo com a aba fechada. "Pausar" para.
- O relógio (pg_cron, `supabase/manual/hunter_cron.sql`) chama `/api/hunter/tick` a cada 2 minutos. A tela do agente só mostra o progresso (somente leitura).
- Só traz empresas **novas**: as que já estão em LEADS são puladas e contadas.
- Se o teto de IA for atingido, o agente **pausa sozinho e avisa**. Nada roda além do teto; é preciso ligar de novo.
- No máximo **3 Caçadores ligados** por workspace. Não dá para arquivar um agente ligado.
- **Relatório de baseline (J3)**: compara a 1ª execução com as listas de `data/gold/` (precisão e cobertura) e propõe a meta semanal. O relatório e as listas ficam fora do repositório (público). Exportar cada aba das listas para CSV em uma pasta (`todos.csv` e `quentes-*.csv`) e rodar, em `kolmeia/app`:
  `BASELINE_FOUND=<run.csv> BASELINE_GOLD_DIR=<pasta> BASELINE_SCHEDULE=weekly BASELINE_AGENT="<agente>" BASELINE_RUN_DATE="dd/mm/aaaa" BASELINE_ALREADY_KNOWN=<n> BASELINE_OUT=<arquivo.md fora de kolmeia/> npm run baseline`
- **Ordem de publicação**: aplicar `0010_hunter.sql`, depois publicar o código, e só então rodar `supabase/manual/hunter_cron.sql`.

## Subir lista (F3c-1)
- **LEADS → Subir lista**: CSV ou XLSX, até **5 MB e 5.000 linhas**. O arquivo é lido no navegador; só as linhas mapeadas vão para o servidor (em lotes de 500), e o servidor confere todas de novo.
- As colunas são detectadas pelo nome do cabeçalho (empresa, site, telefone, e-mail...). Você confere na tela, vê a **prévia** (novos, já existem, com erro) e só então importa.
- **Sem IA** e sem gasto de IA. **Sem duplicar**: empresa que já está em LEADS (mesmo nome, site ou telefone) recebe os dados novos, não vira outro lead.
- Tudo que vem da lista fica **"sem prova"** (importado, não conferido) até alguém conferir. Linha com erro não entra e aparece na lista de erros (telefone em notação científica, ex. 5.08E+09: formate a coluna como texto no Excel).
- **Listas subidas**: se a aba fechar no meio, a lista aparece como "incompleta"; subir o mesmo arquivo de novo só cria o que faltou. **Desfazer import** apaga os leads que a lista criou; leads com dados de outras fontes, já trabalhados ou com a closer ficam.
- Só dono e SDR. A closer não vê o botão nem a tela.
- **Antes de publicar** esta versão do app, aplicar `0011_lists.sql` (depende de 0001-0010).

## Qualificador e Gastos (F3c-2)
- **Qualificador**: sempre ligado. Cada lead passa pela cascata, do grátis ao pago: juntar dados, site, Places, IA leve, IA forte.
- **Tetos** (editáveis em Gastos e no cartão de AGENTES): US$ 5 por dia (dia = meia-noite de Nova York) e US$ 0,50 por lead. A IA forte automática liga e desliga no mesmo formulário.
- **Places** só roda com `GOOGLE_PLACES_API_KEY`; sem ela o cartão avisa e a cascata segue.
- **Gastos** (`/agentes/gastos`, só dono e SDR): cada centavo por agente, passo, modelo, lead e dia, em hoje, 7 ou 30 dias. Abra uma linha para ver os leads dela. Fontes pagas (Apify, Apollo) aparecem à parte.
- **LEADS**: marque leads ou use "Qualificar os próximos 10/25/50 do filtro". A estimativa aparece antes de [Confirmar].
- Aplicar a migração 0014 antes do código. Nenhum cron novo.

## Perfil aprendido e Cobertura (F3c-3)
Antes do código: aplicar `supabase/migrations/0015_profile_coverage.sql` (depende de 0001-0011, 0013 e 0014; não precisa da 0012).

**Perfil aprendido**
- Suba uma lista com "Usar como treino" e clique em Treinar (uma chamada de IA, com estimativa de custo). Sai um cartão com pontos, cada um com as linhas que o provam.
- Você pode aprovar, editar e aprovar, ou descartar. Sem aprovação nada muda: só vale com OK.
- Aprovado para um Caçador (ou todos), a próxima execução dele usa o perfil. A versão fica gravada em cada execução. O filtro do Qualificador segue o perfil aprovado.
- "Comparar com o Caçador" mostra precisão e cobertura do Caçador contra a lista.

**Cobertura** (LEADS, aba só para dono e SDR)
- Lista as 351 cidades de Massachusetts por condado. Cidade coberta = buscada nos últimos 90 dias (Caçador, pesquisa avulsa, lista importada com leads ali, ou marca manual).
- "Já procurei aqui fora do app" cria uma marca manual (cidade, data, nota).
- "Caçar ▸" numa cidade sem busca abre o Caçador com a região preenchida.
- Limites: lê as 500 execuções e 100 listas mais novas, cidades de até 25 listas dentro dos 90 dias (5.000 linhas cada) e até 5.000 leads.

## Pendências
- O painel de uso das caixas (`mailbox_usage`) ainda conta as últimas 24 horas e pode divergir do portão de limite do dia até ser atualizado.

## Rotas antigas
Todas respondem com redirecionamento permanente (308), e a query string é mantida.

| Antiga | Nova |
|---|---|
| `/pesquisa` | `/agentes` |
| `/pesquisa/:id` | `/agentes/pesquisa/:id` |
| `/empresa` | `/configuracoes/empresa` |
| `/email/caixa` | `/configuracoes/caixas` |
| `/email/bloqueados` | `/configuracoes/bloqueados` |
| `/email/closer` | `/leads/closer` |
| `/email` | `/campanhas` |
| `/email/campanhas/:id` | `/campanhas/:id` |
| `/email/campanhas/:id/revisar` | `/campanhas/:id/revisar` |
| `/email/respostas` | `/campanhas/respostas` |

## F5: closer, ligação e Funil

### Ordem de publicação (importante)
**Aplique as migrações `0016` a `0020` no Supabase ANTES de publicar o app.** `LEAD_COLUMNS` (`src/lib/leads/types.ts`) seleciona colunas novas de `leads` (`handed_off_at`, `handed_off_by`, `closer_brief`, `do_not_call`, `do_not_call_at`); com o app novo e o banco antigo, a lista de leads falha. Ordem: 0016, 0017, 0018, 0019, 0020 (SQL Editor, como `postgres`), depois o deploy.

### Papéis
| Papel | Vê | Faz |
|---|---|---|
| owner | tudo | tudo, mais Equipe (convidar a closer) |
| sdr | Agentes, Leads, Campanhas, Funil | passa lead pra closer, agente Ligação, liga |
| closer | só LEADS (Todos, Com a closer, Ligar) | vê só os leads atribuídos a ela, liga, marca ganho/perdido |

### Convidar a closer (Configurações > Equipe, só o dono)
1. Dono informa nome e e-mail da closer e clica em convidar: o app gera um **link** (`/convite/<token>`). A Kolmeia **não envia e-mail**; o dono copia o link e manda ele mesmo.
2. A closer abre o link, cria a conta **com o mesmo e-mail do convite** e confirma o e-mail que o **Supabase** manda (é o e-mail de confirmação do cadastro, não da Kolmeia).
3. Ela abre o link de novo e clica **Entrar na equipe**. Cai em LEADS, sem leads, só com o menu LEADS. Conta que já tem espaço próprio não aceita convite.

### Passar pra closer
No lead, **Passar pra closer**: escolher a closer e escrever o próximo passo. O resumo (quem é, o que disse, próximo passo, prova) é montado **sem IA**. O lead vira `with_closer` (ou continua `meeting`), recebe a closer como responsável e aparece só para ela e em **Com a closer**. Ganho e perdido são marcados à mão (com confirmação) pelo sender ou pela closer atribuída.

### Agente Ligação e lista do dia
- **Agentes > Novo agente > Ligação** (3 perguntas: quais empresas, quantas por dia, quem liga). Nasce pausado; **Ligar** liga e **Pausar** desliga. Não é discador nem voz de IA.
- Regras da lista (`build_call_list`): só lead `new` ou `call_list`, com telefone válido, nível mínimo e temperaturas do filtro, `do_not_call = false`, que **não está com outra pessoa** (nunca tira lead de quem já pegou), no máximo `per_day` por dia (dia de Nova York), sem repetir no mesmo dia. Montar a lista atribui o lead a quem liga. Dono/SDR podem **pôr na lista** um lead à mão (não conta no limite).
- A lista do dia fica em **Leads > Ligar**; o agente mostra "{n} na lista" em Agentes.

### Tela de ligação
Botão com `tel:` (o celular faz a ligação), resumo, prova e um toque no resultado, depois **Salvar e próximo**. **Sem gravação, sem SMS** (em Massachusetts gravar exige o consentimento de todas as partes; SMS frio é proibido). **Só empresas (B2B)**: número residencial exige checar a lista nacional Do Not Call antes, e a Kolmeia ainda não faz essa consulta. Meta: menos de 1 minuto por registro (conferir à mão).

### Resultado da ligação e status
| Resultado | Status do lead |
|---|---|
| `meeting_booked` | `meeting` |
| `not_interested` | `lost` |
| `do_not_call` | `lost` e bloqueado para sempre (`do_not_call = true`) |
| `no_answer`, `voicemail`, `gatekeeper`, `talked`, `wrong_number` | `new` vira `call_list`; os demais não mudam |
`won` e `discarded` nunca mudam. É a mesma tabela em `lead_status_after_call` (SQL) e `statusAfterCall` (`src/lib/calls/view.ts`).

### `do_not_call` e o envio de e-mail (F4)
`leads.do_not_call` vale para **todos os canais**. Listas de ligação já o respeitam. **Os portões de envio do F4 (campanhas de e-mail) devem ler `leads.do_not_call` e nunca escrever para esse lead.** O F4 já faz isso (veja a seção F4: Agente E-mail, trava C2).

### Funil
**Leads > Funil** (dono e SDR): tabela de origem (agente, avulso ou lista importada) por status, com linha de total e coluna de descartados à parte. Só números, sem IA, a partir da mesma lista de LEADS.

## F4: Agente E-mail

### Fluxo
| # | Passo | Quem |
|---|---|---|
| 1 | Criar o agente de e-mail (assistente ou galeria) e escolher os leads (só `new` e `call_list`) | dono ou SDR |
| 2 | A IA escreve **uma** sequência-modelo com `{{first_name}}`, `{{company}}`, `{{city}}` (1 chamada, entra em Gastos) | IA |
| 3 | O dono vê **3 exemplos já preenchidos, com o rodapé** (endereço físico e opt-out) | dono |
| 4 | O dono aprova o **texto exato** que viu | só o dono |
| 5 | Fila: cada lead entra com o modelo aprovado; lead adicionado depois usa o mesmo modelo | sistema |
| 6 | Envio pelo relógio, dentro dos portões, rampa e limites | relógio |

### Aprovação
- **Só o dono aprova** (inclusive aprovação por mensagem de campanhas de sequência; SDR e closer recebem 42501).
- A aprovação vale para um **resumo (digest sha256) dos exemplos renderizados**, do tom e dos intervalos. Se algo mudou entre ver e aprovar, a tela recarrega (erro 40001) e o dono revê.
- Só aprova rascunho, e só a versão mais nova.
- **Editar o texto cancela os rascunhos antigos** (`sequence_edited`) e volta tudo para aprovação.
- Um lead fica em **uma campanha ativa só** (C3). Corpo máximo: 2000 caracteres.

### Paradas automáticas
| Trava | O que para | Por quê |
|---|---|---|
| C2 | `descartado` e `não contatar` (`do_not_call`) | nenhum e-mail, nem resposta pendente |
| C3 | segunda campanha ativa do mesmo lead | prospect fica `stopped` / `in_other_campaign` |
| D5 | `com a closer`, `reunião`, `ganho`, `perdido` | e-mail para; respostas aprovadas ainda saem (só `do_not_call` e `descartado` cancelam resposta) |

### Rampa, pausa e parada de emergência
| O quê | Regra |
|---|---|
| Rampa de aquecimento | 5 e-mails por dia por caixa, +3 por dia útil, até o limite da caixa (dias úteis em UTC) |
| Pausa automática | caixa pausa com 3 ou mais bounces **e** 5% ou mais em 30 dias (DSN forjado não conta duas vezes) |
| Parada de emergência | trava todas as caixas do espaço, inclusive "Enviar teste para mim" |
| Teste de caixa e teste para mim | liberados com o portão fechado, só para o próprio endereço |

### Os 4 cadeados do envio real pelo relógio
O relógio só envia de verdade quando **os quatro** estão ligados. Um faltando = nenhum SMTP.
| # | Cadeado | Quem liga |
|---|---|---|
| 1 | Checklist C12 completo (7 itens, na página da campanha) | Juan, com o login dele |
| 2 | Chave do dono **"Relógio pode enviar de verdade"** (só liga com C12 pronto) | dono |
| 3 | Variável de servidor cujo nome está em `src/lib/email/config.ts` (valor `1`; padrão desligado) | Juan, só na Vercel, quando disser |
| 4 | `MAILBOX_ENC_KEY` presente no servidor | Juan |
Além disso: caixa verificada e saudável, campanha em envio real e ativa, parada de emergência desligada.

### Respostas
O relógio lê as caixas **só por regras** (sem IA): resposta, bounce (DSN), pedido de saída. Citações e rodapés são ignorados; "parar" só vale na própria resposta. Resultado marcado como regra (`class_source = 'rule'`). Pedido de saída cria supressão; bounce conta para a pausa automática. Resposta automática (fora do escritório) **não** tem tratamento: a `0012_auto_reply` não foi restaurada (decisão pendente do Juan).

### Checklist manual C12 (antes de qualquer envio real)
- [ ] **Domínio de envio separado** de `neairhvac.com`, comprado em nome da empresa.
- [ ] **2 a 3 caixas** pagas nesse domínio, conectadas em ⚙ Caixas, "Testar caixa" = ok.
- [ ] **SPF, DKIM (2048 bits) e DMARC** (`p=none` no início, com e-mail de relatório). Conferir com `dig TXT <domínio>`, `dig TXT <seletor>._domainkey.<domínio>`, `dig TXT _dmarc.<domínio>` e um e-mail de teste mostrando `spf=pass dkim=pass dmarc=pass` no Gmail em **Mostrar original**.
- [ ] **Aquecimento**: cada caixa com 2 semanas ou mais de tráfego real baixo antes da campanha (rampa ligada; sem pool de aquecimento).
- [ ] **Endereço físico** real e razão social no perfil de remetente; rodapé visto num exemplo.
- [ ] **Opt-out testado**: link e one-click criam supressão e o próximo envio ao endereço é recusado.
- [ ] **30 a 50 e-mails por dia por caixa** (`daily_limit`) e limite da campanha definido.
- [ ] **OK do dono da Air HVAC** na primeira campanha.
- [ ] Juan registra o checklist no app (só ele).

### Ordem de publicação (importante)
1. Aplicar as migrações **0018 → 0026, em ordem**, no Supabase de desenvolvimento **ANTES** de publicar o app (SQL Editor, como `postgres`). `0016` e `0017` já estão aplicadas no dev desde 15/11.
2. **`0021` nunca sem a `0022`** (a 0022 fecha a trava C2 para leads de prospects). Aplicar as duas juntas, em seguida.
3. **Antes da 0021**, contar (só leitura) os perdedores do back-fill: leads com mais de um prospect ativo em campanhas abertas (via `candidate_id` > `research_candidates.lead_id`). O mais antigo fica com o lock; os outros viram `stopped` / `in_other_campaign`.
4. Só depois publicar o app.
5. **Nada envia de verdade até os 4 cadeados estarem ligados.** Depois do deploy, o envio continua em ensaio.
6. `0012` nunca é aplicada; `0027` não existe.
