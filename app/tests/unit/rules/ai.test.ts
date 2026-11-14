import { describe, test } from "vitest";
import { covered } from "./covered";

// Rule map, area "IA" (docs/mvp-harness.md 11.3).

describe("IA", () => {
  test("R13 Não existe ferramenta de IA que envie, aprove ou apague; a IA só lê e rascunha", () => {
    covered("R13", "tests/unit/guards.test.ts", "tests/engine/engine.test.ts", "tests/engine/email-engine.test.ts");
  });
  test("R14 Ferramenta de IA nunca usa chave de administrador: roda com a sessão do usuário", () => {
    covered("R14", "tests/unit/guards.test.ts", "tests/db/research-rls.test.ts", "tests/db/email-rls.test.ts");
  });
  test("R15 Texto de site entra como dado; texto malicioso não muda o comportamento", () => {
    covered("R15", "tests/engine/engine.test.ts", "tests/unit/research-rules.test.ts", "tests/unit/ai-gateway.test.ts", "tests/engine/email-engine.test.ts", "tests/unit/email-lib.test.ts");
  });
  test("R16 Teto de gasto de IA por workspace por dia; ao bater, a IA para e a tela avisa", () => {
    covered("R16", "tests/unit/ai-gateway.test.ts", "tests/engine/engine.test.ts", "tests/db/research-rls.test.ts", "tests/engine/email-engine.test.ts");
  });
  test("R17 Toda saída de IA guarda modelo, versão do prompt e custo, e aparece como sugestão", () => {
    covered("R17", "tests/unit/ai-gateway.test.ts", "tests/engine/engine.test.ts", "tests/engine/email-engine.test.ts");
  });
  test("R18 (parcial) Campo vazio vira \"?\" e nunca um número inventado -> mesmo teste de P2", () => {
    // Citing the fields used arrives with the score/explanation features (F5).
    covered("P2", "tests/engine/engine.test.ts", "tests/unit/ai-gateway.test.ts");
  });
  test("R18 E-mail nunca inventado: achado na pesquisa com fonte, ou digitado (manual); sem e-mail = não envia", () => {
    covered("R18", "tests/db/email-rls.test.ts", "tests/engine/email-engine.test.ts");
  });
  test.todo("R19 Mudar prompt ou modelo exige rodar o conjunto de avaliação (30 alvos e 30 respostas com gabarito)");
});
