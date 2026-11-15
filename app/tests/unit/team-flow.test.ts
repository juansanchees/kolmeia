import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/configuracoes/equipe/actions", () => ({
  createInviteAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  removeMemberAction: vi.fn(),
}));

import { safeNext } from "@/app/login/next";
import { InviteForm } from "@/components/team/InviteForm";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const TOKEN = "a".repeat(64);

describe("team flow", () => {
  it("safeNext only lets an invite path through", () => {
    expect(safeNext(`/convite/${TOKEN}`)).toBe(`/convite/${TOKEN}`);
    for (const bad of ["//evil.example", "/convite/../x", "https://x.example", "/leads", `/convite/${TOKEN}/x`, `/convite/${TOKEN}\n`, `/convite/${"A".repeat(64)}`, null, undefined, 5, ["/leads"]]) {
      expect(safeNext(bad)).toBe("/");
    }
  });

  it("the invite never sends e-mail and the link is shown once", () => {
    const actions = read("src/app/(app)/configuracoes/equipe/actions.ts");
    for (const word of ["inviteUserByEmail", "nodemailer", "sendMail"]) expect(actions).not.toContain(word);
    expect(read("src/components/team/InviteForm.tsx")).toContain("sendYourself");
  });

  it("Equipe is owner-only", () => {
    expect(read("src/app/(app)/configuracoes/equipe/page.tsx")).toMatch(/role !== "owner"/);
    expect(read("src/app/(app)/configuracoes/equipe/actions.ts")).toMatch(/role !== "owner"/);
  });

  it("the invite form is controlled (keeps typed values after an error)", () => {
    const html = renderToStaticMarkup(createElement(InviteForm));
    expect(html).toMatch(/name="name"[^>]*value=""|value=""[^>]*name="name"/);
    expect(html).toMatch(/name="email"[^>]*value=""|value=""[^>]*name="email"/);
  });

  it("login carries next in a hidden input and redirects only through safeNext", () => {
    expect(read("src/app/login/actions.ts")).toContain("safeNext(");
    expect(read("src/app/login/LoginForm.tsx")).toContain('name="next"');
    expect(read("src/app/login/page.tsx")).toContain("safeNext(");
  });
});
