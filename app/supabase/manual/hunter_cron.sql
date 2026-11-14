-- Caçador em segundo plano (F3b): liga o relogio do Caçador. Rode UMA vez no SQL editor do Supabase.
-- NAO e migration: depende da URL do deploy. Pre-requisitos:
--   1. migration 0010_hunter.sql aplicada;
--   2. relogio do e-mail (scheduler_cron.sql) ja rodado: o token e o MESMO e ja esta no Vault como 'kolmeia_scheduler_token'
--      e o hash em public.scheduler_state. Aqui nao ha segredo nenhum e nenhum token para colar.
-- Troque o placeholder:
--   <APP_URL>  origem https publica do app, sem barra no final   (ex.: https://radar-hvac.vercel.app)
-- Ordem de deploy: 0010, depois o codigo (rota /api/hunter/tick), depois este arquivo.
-- O que o relogio faz: a cada 2 minutos chama a rota, que avanca ate 3 execucoes de Cacadores ligados por ate ~120 s.
-- Sem chave de IA no app a rota responde {"outcome":"no_ai"} e nao toca o banco.

-- 1. Extensoes (ja criadas pelo scheduler_cron.sql; sem efeito se existirem).
create extension if not exists pg_cron with schema pg_catalog;   -- ? verify: schema do pg_cron no seu projeto
create extension if not exists pg_net with schema extensions;

-- 2. O job: a cada 2 minutos, POST na rota com o Bearer lido do Vault na hora da execucao.
select cron.schedule(
  'kolmeia-hunter',
  '*/2 * * * *',
  $job$
  select net.http_post(
    url := '<APP_URL>/api/hunter/tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kolmeia_scheduler_token' limit 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000   -- ? verify: limite maximo de timeout do pg_net no seu projeto
  );
  $job$
);

-- 3. Confira (espere 2-6 minutos, como dono do projeto no SQL editor; clientes nao leem esta tabela):
--   select started_at, finished_at, counts, error from public.hunter_ticks order by started_at desc limit 10;
--   select status_code, error_msg, created from net._http_response order by created desc limit 5;   -- ? verify: tabela/colunas do log do pg_net

-- ---------------------------------------------------------------- PARAR O RELOGIO (STOP)
-- select cron.unschedule('kolmeia-hunter');
-- (para tudo de uma vez, inclusive o e-mail, veja scheduler_cron.sql: apagar o hash faz o banco recusar todas as chamadas)

-- ---------------------------------------------------------------- SE A VERCEL RECUSAR maxDuration = 300 (plano) — plano B, nesta ordem:
--   a) no codigo: maxDuration = 60 em src/app/api/hunter/tick/route.ts; HUNTER_TICK_BUDGET_MS = 0 (um passo por chamada)
--      em src/lib/hunter/tick.ts; batchSize: 1 no runHunterTick da rota;
--   b) aqui: troque '*/2 * * * *' por '* * * * *' e timeout_milliseconds := 60000
--      (select cron.unschedule('kolmeia-hunter'); e rode o passo 2 de novo);
--   c) se UM passo de busca ainda nao couber em 60 s: PARE e pergunte ao Juan (upgrade de plano).
