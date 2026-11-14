import { describe, test } from "vitest";
import { covered } from "./covered";

// Rule map, area "Envio e e-mail" (docs/mvp-harness.md section 5). `todo` = a later phase must turn it green.

const DB = "tests/db/email-rls.test.ts";
const ENGINE = "tests/engine/email-engine.test.ts";
const LIB = "tests/unit/email-lib.test.ts";
const GUARDS = "tests/unit/guards.test.ts";

describe("Envio e e-mail", () => {
  test("R1 Nenhum e-mail sai sem registro em `approvals`", () => {
    // claim refuses unapproved; stamp by set_email_approval only; edit clears approval; approval log; guards: only a user action approves
    covered("R1", DB, ENGINE, GUARDS);
  });
  test("R2 Nunca passar do limite diário da caixa nem do intervalo mínimo", () => {
    // calendar-day limit by sending address (cap 50, owner-only) and by campaign, 9 + 5 min gap, window in the campaign's zone, concurrent claims
    covered("R2", DB, ENGINE);
  });
  test("R3 Nunca enviar para quem está em `suppressions`, com `opt_out` ou `email_bounced`", () => {
    // address/domain suppression inside the claim, unsubscribe link, bounce, "remove me" label
    covered("R3", DB, ENGINE);
  });
  test("R4 Todo e-mail tem nome real, endereço físico, link e cabeçalho de descadastro", () => {
    // footer + List-Unsubscribe/-Post headers, no claim without full sender profile, real sending owner-only, honest subjects
    covered("R4", DB, ENGINE, LIB);
  });
  test("R5 Resposta para a sequência do contato; opção de parar a empresa inteira", () => {
    // a reply cancels the remaining steps; a domain suppression stops the whole company
    covered("R5", DB, ENGINE);
  });
  test.todo("R6 Bounce acima de 2% após 50 envios pausa a caixa (?: calibrar)");
  test("R7 No máximo 1 pessoa da mesma empresa por dia", () => {
    covered("R7", "tests/db/gates.test.ts");
  });
  test("R8 Workspace A nunca lê nem escreve dado do workspace B", () => {
    covered("R8", "tests/db/rls.test.ts", "tests/db/research-rls.test.ts", DB);
  });
  test("R9 Mesmo passo nunca é enviado duas vezes (idempotência)", () => {
    // unique (prospect, step), a claimed message is never claimed again, stale claims become failed (never resent)
    covered("R9", DB, ENGINE);
  });
  test("R10 Senha, chave e corpo de lead nunca aparecem em log", () => {
    // AES-256-GCM at rest, ciphertext not selectable, safe SMTP error text, no console calls in the e-mail code
    covered("R10", LIB, ENGINE, GUARDS);
  });
  test("R11 Não existe caminho de código para SMS frio nem para LinkedIn", () => {
    // dependencies, src mentions, web tools blocked_domains, URL filter, database check constraints, e-mail area words
    covered("R11", GUARDS, "tests/unit/research-rules.test.ts", "tests/db/research-rls.test.ts", "tests/engine/engine.test.ts");
  });
  test("R12 Primeiro e-mail em texto puro, sem link além do descadastro, sem rastreio de abertura", () => {
    // plain text only (no HTML part, no tracking pixel), links refused in sequence bodies (code + database)
    covered("R12", DB, ENGINE, LIB);
  });
});
