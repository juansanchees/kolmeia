import { expect, test } from "vitest";
import { t } from "@/messages/pt";
import { dateLineOf } from "@/lib/home/view";

const NOW = new Date("2026-11-17T15:00:00Z"); // 10:00 in New York (EST)

test("date line in pt-BR, New York day, upper case", () => {
  expect(dateLineOf(NOW, t)).toBe("TERÇA, 17 DE NOVEMBRO");
  expect(dateLineOf(new Date("2026-11-18T03:00:00Z"), t)).toBe("TERÇA, 17 DE NOVEMBRO"); // still the 17th in NY
  expect(dateLineOf(new Date("2026-11-21T15:00:00Z"), t)).toBe("SÁBADO, 21 DE NOVEMBRO");
});
