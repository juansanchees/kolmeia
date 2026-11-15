# Runbook: Supabase de PRODUÇÃO da Kolmeia

Objetivo: criar um projeto Supabase novo só para produção e trocar o app para ele. O dev (`drkonindwshyyaemkcod`) fica como está.
Fontes: `app/README.md`, `app/supabase/migrations/`, `app/supabase/manual/*_cron.sql`, `app/.env.example`, `.superpowers/sdd/.../final-review.md`.
Legenda: `?` = não verificado.

## 0. Quem faz o quê

| Quem | Faz |
|---|---|
| Juan | Cria a conta/projeto Supabase, escolhe plano, cola as chaves públicas, cola segredos na Vercel (ou entrega por pipe), liga/desliga chaves do dono |
| Claude | Aplica SQL (SQL Editor, papel `postgres`), configura cron, confere resultados, redeploy, smoke tests |
| Regra | Claude **nunca** cria conta/projeto/chave. Segredo nunca no chat, no git ou em screenshot |

## 1. Criar o projeto (Juan)

| Item | Valor |
|---|---|
| Nome | `kolmeia-prod` (sugestão) |
| Região | US East (N. Virginia) `us-east-1` |
| Plano | Pro (?) — Free pausa o projeto por inatividade e o cron precisa rodar sem parar. Confirmar preço no painel |
| Senha do banco | gerar no painel, guardar no gerenciador de senhas. Não colar no chat |
| Chaves a me passar | só `Project URL` e `anon key` (públicas). **Não** existe service role neste produto (regra R14) |

### Auth (Dashboard > Authentication)

| Ajuste | Valor | Por quê |
|---|---|---|
| Confirm email | **LIGADO** | o aceite do convite da closer depende de `email_confirmed_at`; desligado, o cadastro revela se o e-mail existe |
| Site URL | `https://kolmeia.solutions` | |
| Redirect URLs | `https://kolmeia.solutions/**` (e `http://localhost:3000/**` só se for testar local) | |
| Convites | o app gera o link `/convite/<token>`; o dono manda ele mesmo. Kolmeia não envia e-mail | |
| SMTP de auth | ? decidir: o SMTP padrão do Supabase tem limite baixo; ver se o e-mail de confirmação chega | |

### Extensões (Dashboard > Database > Extensions, ou SQL)

| Extensão | Para quê |
|---|---|
| `pg_cron` | relógios |
| `pg_net` | cron chama as rotas HTTP |
| `supabase_vault` (`vault`) | guarda o token do relógio |
| `pgcrypto` | `gen_random_bytes` para gerar o token dentro do Postgres |

```sql
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;   -- ? schema do pg_cron no projeto novo
-- vault: ligar pelo painel se não existir (? create extension supabase_vault)
```

## 2. Migrações 0001 a 0026 (Claude)

Regras: SQL Editor, papel `postgres`. **Não existe `0012`** (nunca aplicar; `0027` também não existe). Pasta: `app/supabase/migrations/`.

### Cuidado ao colar SQL (já deu mojibake)

| Faça | Não faça |
|---|---|
| Colar via `monaco setValue` no editor, **ou** `LC_ALL=en_US.UTF-8 pbcopy < arquivo.sql` | `pbcopy` sem locale UTF-8 |
| Conferir o tamanho: caracteres do arquivo = caracteres no editor | Aplicar sem conferir contagem |
| Aplicar um arquivo por vez e anotar "Success" | Colar vários arquivos juntos (exceto 0021+0022) |

### Pré-checagens (do `final-review.md`, "Apply order + pre-apply checks")

Banco novo e vazio, então a maioria é trivial. Mesmo assim:

| # | Checagem | Esperado no banco novo |
|---|---|---|
| 1 | Snapshot/backup antes de começar | nada a salvar; anotar a hora |
| 2 | `select count(*) from email_messages where status='sending'` (só depois da 0003) | 0 |
| 3 | Perdedores do back-fill da 0021 (prospects ativos por lead em campanhas abertas > 1, via `candidate_id` > `research_candidates.lead_id`) | 0 linhas (sem dados) |
| 4 | Prospects ativos cujo lead é discarded / do_not_call / with_closer / meeting / won / lost (D5) | 0 linhas |
| 5 | Cron parado durante o apply | ainda não existe cron: só criar na seção 3 |

### Ordem de aplicação

| Ordem | Arquivo | Nota |
|---|---|---|
| 1-4 | `0001_foundation` `0002_research` `0003_email` `0004_research_hardening` | base; não editar depois de aplicadas |
| 5 | `0005_scheduler` | cria `scheduler_state` (hash do token) |
| 6-7 | `0006_gates` `0007_rotation` | 0007 antes de publicar o app |
| 8 | `0008_agents` | depende de 0001-0004 |
| 9-10 | `0009_leads` `0010_hunter` | |
| 11 | `0011_lists` | |
| (pula) | `0012` | **não existe, não aplicar** |
| 12-15 | `0013_sources` `0014_qualifier` `0015_profile_coverage` `0016_source_contacts` | |
| 16 | `0017_closer_scope` | |
| 17 | `0018_c12_gate` | |
| 18-19 | `0019_qualifier_requeue` `0020_calls_closer` | 0020 é exigida pelo código (`LEAD_COLUMNS`) |
| 20-21 | `0021_lead_campaigns` + `0022_lead_gate` | **juntas, na mesma sessão** (0021 sem 0022 deixa a trava C2 aberta) |
| 22-25 | `0023_email_sequences` `0024_mailbox_health` `0025_clock_real` `0026_clock_replies` | |

Item I1 do review (0021 não re-rodável após dados): corrigido no commit `8310699` ("re-runnable 0021 stop reasons"). Banco novo aplica uma vez só. Conferir que a 0021 do repo já traz `'lead_status'` (?).

### Depois de aplicar

```sql
notify pgrst, 'reload schema';
-- deve retornar 0 linhas (funções duplicadas):
select proname, count(*) from pg_proc
 where proname like 'scheduler_%' or proname like 'claim_%' group by 1 having count(*) > 1;
-- deve ser false em todo lugar:
select * from public.workspace_settings where clock_real_enabled is not false;
```

Conferir também: RLS ligada nas tabelas (`select relname from pg_class where relrowsecurity = false and relnamespace='public'::regnamespace and relkind='r'`) (?) e `scheduler_state` tem 1 linha (id=1) com `token_sha256` nulo.

## 3. Token do relógio + cron (Claude, com o Juan olhando)

Base: `app/supabase/manual/scheduler_cron.sql` e `hunter_cron.sql`. Não são migrações (dependem da URL do deploy).

### Token gerado DENTRO do Postgres (nunca passa pelo chat)

O arquivo manual pede um token em texto puro. Em produção, gerar no banco para ele nunca aparecer na tela:

```sql
-- ? testar no projeto novo; adapta o passo 2-3 do scheduler_cron.sql
do $$
declare t text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform vault.create_secret(t, 'kolmeia_scheduler_token', 'Bearer token for /api/scheduler/tick');
  update public.scheduler_state
     set token_sha256 = encode(extensions.digest(convert_to(t, 'UTF8'), 'sha256'), 'hex')
   where id = 1;
end $$;
```

| Ponto | Detalhe |
|---|---|
| Hash | sha256 do mesmo texto hex de 64 caracteres (igual ao arquivo manual) |
| Vault | segredo `kolmeia_scheduler_token`; criar 2 vezes dá erro (para trocar, usar o bloco "ROTATE" do arquivo) |
| Token no cron | o job lê do Vault na hora; nada de segredo no texto do job |

### Jobs

| Job | Agenda | Rota | Nota |
|---|---|---|---|
| `kolmeia-hunter` | **a cada minuto** `* * * * *` | `<APP_URL>/api/hunter/tick` | o `hunter_cron.sql` traz `*/2`; o `pg_net` falha em HTTP/2 de forma alternada (1 em 2), então a cada minuto garante 1 sucesso a cada 2 min. Para o `timeout_milliseconds` do plano B do arquivo, usar 60000 (? se a Vercel aceitar `maxDuration = 300`, manter 300000) |
| `kolmeia-tick` (e-mail) | `*/5 * * * *` (do arquivo) | `<APP_URL>/api/scheduler/tick` | **só ensaio**. Manter assim: o banco recusa campanha que não esteja em ensaio e o SMTP do relógio falha sempre |

`<APP_URL>` = `https://kolmeia.solutions` (sem barra no final). Ordem: migrações, depois deploy do código (rotas existem), **depois** os jobs.

Trocar o `*/2` do arquivo do hunter por `* * * * *` no momento de colar (Claude edita a cópia colada, não o arquivo do repo, a menos que o Juan peça).

### Conferir (esperar 2-6 min)

```sql
select started_at, finished_at, counts, error from public.hunter_ticks order by started_at desc limit 10;
select started_at, outcome, sent, failed, error from public.scheduler_runs order by started_at desc limit 10;
select status_code, error_msg, created from net._http_response order by created desc limit 10;   -- ? colunas do pg_net
```

Esperado: `hunter_ticks` com `{"outcome":"no_ai"}` se ainda sem `ANTHROPIC_API_KEY`; `scheduler_runs` com `sent: 0` real. Falhas esporádicas de HTTP/2 no `net._http_response` são esperadas; o problema é 2 falhas seguidas em muitos ticks.

Parar tudo: `select cron.unschedule('kolmeia-hunter'); select cron.unschedule('kolmeia-tick');` e `update public.scheduler_state set token_sha256 = null where id = 1;` (o banco passa a recusar todas as chamadas).

## 4. Vercel (produção)

Projeto e domínio: o do app Kolmeia (`kolmeia.solutions`) (? confirmar qual projeto Vercel e se o domínio já aponta para ele).

| Variável (só nomes) | Escopo | Valor vem de | Obrigatória |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | público | Project URL do projeto novo | sim |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | público | anon key do projeto novo | sim |
| `ANTHROPIC_API_KEY` | servidor | Console da Anthropic (busca na web ligada na organização) | sim para Pesquisa/Caçador; sem ela "IA não configurada" |
| `MAILBOX_ENC_KEY` | servidor | `openssl rand -base64 32`, **chave nova de produção** (não reutilizar a do dev) | sim para conectar caixas |
| `APP_PUBLIC_ORIGIN` | servidor | `https://kolmeia.solutions` | sim (links de descadastro) |
| `AI_USER_DAILY_CAP_USD` / `AI_GLOBAL_DAILY_CAP_USD` | servidor | opcional; só baixam os tetos (padrão 10 e 25) | não |
| `GOOGLE_PLACES_API_KEY` | servidor | opcional; vazio = "Places desligado" | não |
| `MAILBOX_ENC_KEY_PREVIOUS` | servidor | só durante rotação de chave | não |
| **`SCHEDULER_REAL_SEND`** | — | **NÃO DEFINIR.** É o cadeado 3 do envio real. Só o Juan, só quando disser | **deve ficar ausente** |

Não existe `SUPABASE_SERVICE_ROLE_KEY` neste produto (R14). Se aparecer pedido por ela, parar e perguntar.

### Passos

| # | Passo | Quem |
|---|---|---|
| 1 | Trocar as 2 variáveis `NEXT_PUBLIC_*` do ambiente Production | Juan (ou Claude via CLI, com a chave colada por pipe) |
| 2 | Conferir/criar as demais variáveis; **confirmar que `SCHEDULER_REAL_SEND` não existe** | Claude |
| 3 | Redeploy de produção (as `NEXT_PUBLIC_*` são embutidas no build: precisa rebuild, não só reiniciar) | Claude |
| 4 | Só depois: criar os cron jobs (seção 3) | Claude |

### Smoke tests

| Teste | Esperado |
|---|---|
| Abrir `https://kolmeia.solutions` | carrega, sem "Banco não configurado" |
| Cadastro do dono + confirmar e-mail + login | entra; cria espaço (RPC `create_workspace`) |
| Criar espaço e conferir que o criador é `owner` | trigger de dono único ok |
| Pesquisa curta (rigor mais baixo) | roda; linha em `ai_calls`; teto de custo respeitado |
| Convite da closer: gerar link, aceitar com outro e-mail | closer vê só Leads (depende de `email_confirmed_at`) |
| Conectar caixa Gmail (senha de app), em **ensaio** | verifica; nenhum envio real |
| Campanha em ensaio + "Enviar os de hoje" | linhas em ensaio, nenhum SMTP |
| Cron: ver `hunter_ticks` e `scheduler_runs` | ticks chegando, `sent: 0` real |
| `workspace_settings.clock_real_enabled` | false |
| Link de descadastro de um e-mail de ensaio | usa `https://kolmeia.solutions` |

Envio real continua exigindo os 4 cadeados (C12 completo, chave do dono, `SCHEDULER_REAL_SEND=1`, `MAILBOX_ENC_KEY`). Fora do escopo deste runbook.

## 5. Dados

**Decidido (15/11/2026, Juan): o prod NÃO começa vazio.** Os dados reais do dev vão para o prod. O workspace fictício de teste, os segredos e os logs do relógio ficam de fora.

| Vai para o prod | Fica de fora |
|---|---|
| Workspace real e seu dono: `auth.users` + `auth.identities` com o mesmo id, para manter os vínculos | Workspace "TESTE relógio (fictício)", com tudo dele e o usuário fictício. Hoje todo e-mail, caixa, supressão e campanha do dev é desse workspace |
| Leads, `lead_fields`, importações, pesquisas, agentes, qualificador e sua fila/log, perfis, `ai_calls`, `ai_access`, `ai_limits`, `source_runs` | `source_connections` (token do Apify cifrado: cadastrar de novo no prod, já rotacionado) e `mailboxes` (senha de caixa cifrada) |
| | `scheduler_state` (o prod tem token próprio, passo 90), `*_ticks`, `scheduler_runs`, `workspace_invites` |

Linhas iniciais criadas pelas migrações: `scheduler_state` (1) e `ai_limits` (1). Os dados trocam `ai_limits` pela linha do dev; `scheduler_state` fica a do prod.

Como gerar e aplicar (testado por inteiro num banco local igual ao prod):
1. Rodar o backup (seção 8) e restaurá-lo num container descartável.
2. No container, rodar `.superpowers/prod/transfer-build.sql`, que apaga o que fica de fora.
3. Fazer o `pg_dump --data-only` do container e guardar em `~/kolmeia-backups/<data>/transfer/`. Esse arquivo tem dados reais e nunca entra no git.
4. Rodar `zsh kolmeia-prod-setup.sh <ref> <pooler-host>` (fica na pasta acima do repo). O script pede a senha sem mostrar e para se o banco não estiver vazio. Ele aplica a seção 1, as migrações, os passos 89/90/91 (grants, token, relógios **desligados**), o usuário e os dados (`session_replication_role = replica`, uma transação), e roda as checagens (92, contagens e acesso).

## 6. Rollback

| Situação | Ação |
|---|---|
| Algo errado no app novo | na Vercel, voltar as 2 `NEXT_PUBLIC_*` para o dev e redeploy (o dev segue intacto). Ou "Promote" do deploy anterior |
| **Voltar ao dev depois da troca de 15/11/2026** | Fazer na ordem: (1) prod: `select cron.alter_job(jobid, active := false) from cron.job;`; (2) dev: o mesmo com `active := true`; (3) `vercel --global-config ~/.vercel-kolmeia rollback kolmeia-g4k7mxbqq-kolmeia-team.vercel.app`. Esse deploy já tem as chaves do dev embutidas. Num redeploy depois disso, voltar antes as 2 `NEXT_PUBLIC_*` para o dev (a chave anon do dev está no painel do dev). O que foi criado no prod depois da troca não existe no dev |
| Cron fazendo bobagem | `select cron.unschedule('kolmeia-hunter'); select cron.unschedule('kolmeia-tick');` + `token_sha256 = null` (falha fechada) |
| Migração falhou no meio | anotar o arquivo e o erro exato; não editar migração já aplicada; corrigir com migração nova numerada. Projeto ainda vazio: pode recriar o projeto do zero |
| Vazou token/chave | token do relógio: bloco "ROTATE THE TOKEN" do `scheduler_cron.sql`; `MAILBOX_ENC_KEY`: gerar nova, `MAILBOX_ENC_KEY_PREVIOUS` = antiga, reconectar caixas, esvaziar a antiga; `ANTHROPIC_API_KEY`: revogar na Console |
| Envio real saiu sem querer | parada de emergência no app, remover `SCHEDULER_REAL_SEND`, desligar a chave do dono, `unschedule` |

## 6b. Plano Free: pausa por inatividade

- Doc oficial (supabase.com/docs/guides/platform/free-project-pausing): o projeto pausa depois de 7 dias de pouca "user database activity". O dono recebe um e-mail de aviso cerca de 1 semana antes. "Resume project" devolve dados e configurações em até 1 ano.
- **Não está comprovado** que o pg_cron/pg_net conta como atividade. A doc não define "user". Não contar com os relógios para manter o projeto ativo.
- O que conta, segundo a doc: abrir o projeto no painel e chamadas de API do app. Até decidir: deixar o e-mail de aviso chegar ao Juan e responder abrindo o painel. Se for usar o app todo dia, o uso real basta. Só o plano Pro nunca pausa (decisão do Juan, é pago).

## 7. Checklist final (marcar no dia)

- [ ] Projeto criado, região us-east, Confirm email ligado, URLs `kolmeia.solutions`
- [ ] Extensões pg_cron, pg_net, vault, pgcrypto ligadas
- [ ] 0001 a 0026 aplicadas (sem 0012), 0021+0022 juntas, `notify pgrst` rodado
- [ ] Checagens pós-apply: 0 funções duplicadas, `clock_real_enabled` false
- [ ] Token no Vault + hash em `scheduler_state` (gerado no Postgres)
- [ ] Vercel: variáveis certas, `SCHEDULER_REAL_SEND` ausente, redeploy feito
- [ ] Jobs: hunter a cada minuto, e-mail `*/5` só ensaio; ticks verdes
- [ ] Smoke tests ok

## 8. Backup e recuperação (testado em 15/11/2026)

**Backup:** `zsh kolmeia-backup-dev.sh`, na pasta acima do repo. Para o prod, trocar `REF` e `HOST` no script. Ele pede a senha do banco sem mostrá-la e roda o `pg_dump` 17 no Docker pelo session pooler. Gera em `~/kolmeia-backups/<data-hora>/` (pasta 700, fora do git):
- `public.dump`: estrutura e dados do app;
- `auth_cron.sql`: `auth.users`, `auth.identities` e `cron.job`, com nomes de coluna;
- `schema.sql`: só a estrutura, para comparar.

Logo depois, rodar `.superpowers/prod/baseline.sql` no banco de origem. Ele dá a impressão digital: linhas por tabela e contagem + md5 de funções, políticas, constraints, índices, gatilhos, RLS e grants.

**Não restaurar o `public.dump` inteiro.** Testado: o Supabase dá grants padrão a `anon` e `authenticated` em todo objeto novo, e o dump não revoga. O resultado foi `anon` com ALL nas 51 tabelas e EXECUTE em 228 funções. O RLS ainda filtra as linhas, mas é uma brecha.

**Recuperação certa (testada):** sempre num projeto novo e vazio, nunca por cima do dev ou do prod.
1. Estrutura pelas migrações do repo, no mesmo commit do backup: seção 1, migrações em ordem sem 0012, depois 89 (grants), 90 (token novo, porque o Vault não está no dump) e 91 (relógios desligados).
2. Usuários: as linhas `INSERT INTO auth.*` do `auth_cron.sql`. Os jobs não: o 91 recria os jobs, desligados.
3. Dados: `pg_restore --data-only -L <lista sem scheduler_state>`. Antes, apagar a linha inicial de `ai_limits`. Carregar via `psql` com `set session_replication_role = replica;` no início e tudo em uma transação (`-1`), sem gatilhos, que somariam custo em dobro. O `PGOPTIONS` é recusado para o `postgres`; o `SET` na sessão funciona.
4. Conferir:
   - `baseline.sql`: linhas iguais às do backup (os `*_ticks` e `scheduler_runs` crescem a cada minuto no dev; diferença pequena ali é normal);
   - `92-checks.sql`;
   - `restore-verify.sql`: revalida todas as FK e CHECK, testa dono, closer fictícia e anon, e termina em ROLLBACK.
5. Com tudo certo: trocar a Vercel (seção 4) e ligar os relógios (`cron.alter_job(..., active := true)`).

Resultado do teste (backup do dev de 15/11, container `supabase/postgres:17.12` descartável):

| Checagem | Resultado |
|---|---|
| Linhas por tabela (51) | iguais ao backup (731 leads, 7001 `lead_fields`) |
| Funções, políticas, constraints, índices, gatilhos | md5 iguais ao dev (287/86/478/132/62) |
| RLS forçado | 51/51 |
| Grants de funções | md5 igual ao dev, depois do passo 89 |
| Grants de tabelas para `service_role` | diferem só na imagem local (padrão dela). Conferir no projeto real |
| Integridade | 410 FK/CHECK revalidadas sem erro |
| Acesso | dono vê 731; closer vê só os 2 leads entregues e nenhuma campanha ou caixa; edição de lead alheio negada; anon negado |
| `92-checks` | limpo; envio real travado (`clock_real` 0, C12 0, campanhas em ensaio) |

Limites do teste: a imagem local tem um `auth` mais antigo, então o teste criou as colunas que faltavam. Com isso, o login no app restaurado não foi testado. O teste de verdade do login é o do prod (seção 4/smoke).
