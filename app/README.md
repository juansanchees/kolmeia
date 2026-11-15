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
2. Aplicar as migrações de `supabase/migrations/` em ordem, de `0001` a `0006` (SQL Editor, como o papel `postgres`). A `0006_gates.sql` tem que estar aplicada **antes** de publicar esta versão do app.
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
- **Para ligar (uma vez, o dono):** aplicar as migrações `0005_scheduler.sql` e `0006_gates.sql` e colar `supabase/manual/scheduler_cron.sql` no editor SQL do Supabase, trocando `<APP_URL>` e `<TOKEN>`. O mesmo arquivo tem os comandos para parar o relógio e trocar o token.

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
