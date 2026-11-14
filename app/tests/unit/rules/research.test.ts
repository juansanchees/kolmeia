import { describe, test } from "vitest";
import { covered } from "./covered";

// Rule map, area "Pesquisa" (docs/mvp-harness.md 12.5 and 12.9).

describe("Pesquisa", () => {
  test("P1 Nenhuma afirmação sobre uma empresa sem `source_url` e `seen_at`", () => {
    covered("P1", "tests/unit/research-rules.test.ts", "tests/db/research-rls.test.ts", "tests/engine/engine.test.ts");
  });
  test("P2 Sem fonte = `?`; nunca valor inventado", () => {
    covered("P2", "tests/engine/engine.test.ts", "tests/unit/ai-gateway.test.ts");
  });
  test("P3 Empresa só entra no E-mail se o usuário aprovou na Pesquisa", () => {
    covered("P3", "tests/db/research-rls.test.ts", "tests/engine/engine.test.ts");
  });
  test("P4 Busca só começa depois de o plano ser aprovado", () => {
    covered("P4", "tests/db/research-rls.test.ts", "tests/engine/engine.test.ts");
  });
  test("P5 A segunda passada não recebe a conclusão da primeira (só as provas)", () => {
    covered("P5", "tests/engine/engine.test.ts");
  });
  test("P6 Toda pesquisa tem teto de custo e de tempo; ao bater, para e entrega o que tem, marcado como parcial", () => {
    covered("P6", "tests/engine/engine.test.ts", "tests/unit/ai-gateway.test.ts");
  });
  test.todo("P7 Conjunto de avaliação da Pesquisa: empresas com gabarito rodado antes de mudar prompt, fonte ou modelo");
  test("P8 Nenhuma região é recusada por falta de conector", () => {
    covered("P8", "tests/unit/research-rules.test.ts");
  });
  test("P9 Afirmação com uma só fonte aparece como \"?\" (pesquisa rigorosa)", () => {
    covered("P9", "tests/unit/research-rules.test.ts", "tests/db/research-rls.test.ts", "tests/engine/engine.test.ts");
  });
  test("P10 A lista entregue traz a relação de fontes consultadas, incluindo as que não renderam nada", () => {
    covered("P10", "tests/unit/research-rules.test.ts", "tests/engine/engine.test.ts");
  });
});
