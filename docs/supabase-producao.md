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

| Decisão | Padrão |
|---|---|
| Começar **vazio**, sem copiar leads do dev | sim, padrão |
| Copiar dados do dev | só se o Juan decidir. Aí: dump só de tabelas escolhidas, rever RLS/`workspace_id`/`owner_id` (ids de usuário do dev não existem no prod) e rodar as pré-checagens 3 e 4 da seção 2 (?) |
| Seeds | o schema não depende de seed para subir (? confirmar tabelas com linhas iniciais: `scheduler_state`, `ai_limits`, `workspace_settings`) |

## 6. Rollback

| Situação | Ação |
|---|---|
| Algo errado no app novo | na Vercel, voltar as 2 `NEXT_PUBLIC_*` para o dev e redeploy (o dev segue intacto). Ou "Promote" do deploy anterior |
| Cron fazendo bobagem | `select cron.unschedule('kolmeia-hunter'); select cron.unschedule('kolmeia-tick');` + `token_sha256 = null` (falha fechada) |
| Migração falhou no meio | anotar o arquivo e o erro exato; não editar migração já aplicada; corrigir com migração nova numerada. Projeto ainda vazio: pode recriar o projeto do zero |
| Vazou token/chave | token do relógio: bloco "ROTATE THE TOKEN" do `scheduler_cron.sql`; `MAILBOX_ENC_KEY`: gerar nova, `MAILBOX_ENC_KEY_PREVIOUS` = antiga, reconectar caixas, esvaziar a antiga; `ANTHROPIC_API_KEY`: revogar na Console |
| Envio real saiu sem querer | parada de emergência no app, remover `SCHEDULER_REAL_SEND`, desligar a chave do dono, `unschedule` |

## 7. Checklist final (marcar no dia)

- [ ] Projeto criado, região us-east, Confirm email ligado, URLs `kolmeia.solutions`
- [ ] Extensões pg_cron, pg_net, vault, pgcrypto ligadas
- [ ] 0001 a 0026 aplicadas (sem 0012), 0021+0022 juntas, `notify pgrst` rodado
- [ ] Checagens pós-apply: 0 funções duplicadas, `clock_real_enabled` false
- [ ] Token no Vault + hash em `scheduler_state` (gerado no Postgres)
- [ ] Vercel: variáveis certas, `SCHEDULER_REAL_SEND` ausente, redeploy feito
- [ ] Jobs: hunter a cada minuto, e-mail `*/5` só ensaio; ticks verdes
- [ ] Smoke tests ok
