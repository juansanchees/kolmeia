-- ATENCAO (dono):
--  (a) Gere o token com:  openssl rand -hex 32
--  (b) Depois de colar e rodar este SQL, APAGUE a entrada do historico do SQL editor: o token aparece em texto puro la.
--  (c) Para rodar de novo, use SO o bloco "ROTATE THE TOKEN" no fim: criar o segredo no Vault duas vezes da erro.

-- E1 "Relogio": turns the clock on. Run ONCE by the owner in the Supabase SQL editor, after migration 0005 is applied.
-- NOT a migration: it holds a secret and depends on your deployment URL. Replace the two placeholders first:
--   <APP_URL>  the public https origin of the app, no trailing slash   (e.g. https://radar-hvac.vercel.app)
--   <TOKEN>    64 lowercase hex characters you generate yourself        (e.g. run: openssl rand -hex 32)
-- Keep the token out of chat, git and screenshots. The app host never stores it: Postgres keeps the hash and the Vault
-- keeps the value pg_cron sends. What this clock does: every 5 minutes it processes approved, due e-mails of campaigns
-- in rehearsal (ensaio) mode. It cannot send real mail, read replies or touch a mailbox password.

-- 1. Extensions. (On Supabase, pg_cron lives in the "extensions"/"pg_catalog" area and pg_net in "extensions".)
create extension if not exists pg_cron with schema pg_catalog;   -- ? verify: schema name for pg_cron on your project (Dashboard > Database > Extensions)
create extension if not exists pg_net with schema extensions;

-- 2. Store the token in the Vault (so it is not written in the cron job's text).
select vault.create_secret('<TOKEN>', 'kolmeia_scheduler_token', 'Bearer token for /api/scheduler/tick');

-- 3. Store the token's hash where the database checks it (sha256 of the same 64-hex text).
update public.scheduler_state
   set token_sha256 = encode(sha256(convert_to('<TOKEN>', 'UTF8')), 'hex')
 where id = 1;

-- 4. The job: every 5 minutes, POST to the tick route with the Bearer header read from the Vault at run time.
select cron.schedule(
  'kolmeia-tick',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := '<APP_URL>/api/scheduler/tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kolmeia_scheduler_token' limit 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

-- 5. Check it works (wait 5-10 minutes, then):
--   select started_at, finished_at, outcome, campaigns, sent, failed, error from public.scheduler_runs order by started_at desc limit 10;
--   (run it as the project owner in the SQL editor; clients cannot read this table)
--   select status_code, error_msg, created from net._http_response order by created desc limit 5;   -- ? verify: table/columns of pg_net's response log

-- ---------------------------------------------------------------- STOP THE CLOCK
-- select cron.unschedule('kolmeia-tick');
-- update public.scheduler_state set token_sha256 = null where id = 1;   -- also makes the database refuse every call (fail closed)

-- ---------------------------------------------------------------- ROTATE THE TOKEN (new 64-hex value: <NEW_TOKEN>)
-- select vault.update_secret((select id from vault.secrets where name = 'kolmeia_scheduler_token'), '<NEW_TOKEN>');   -- ? verify: vault.update_secret signature (secret id, new secret)
-- update public.scheduler_state set token_sha256 = encode(sha256(convert_to('<NEW_TOKEN>', 'UTF8')), 'hex') where id = 1;
-- (the next tick uses the new value; the old token stops working the moment the hash changes)
