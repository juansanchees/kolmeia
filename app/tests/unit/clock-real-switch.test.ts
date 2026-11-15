import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clockRealGate } from "@/components/email/C12Checklist";

const root = path.resolve(import.meta.dirname, "../..");
const actions = readFileSync(path.join(root, "src/app/(app)/campanhas/c12-actions.ts"), "utf8");
const ui = readFileSync(path.join(root, "src/components/email/C12Checklist.tsx"), "utf8");

describe("clockRealGate", () => {
  const base = { approved: 7, total: 7, isOwner: true, enabled: false };
  test("owner with 7 of 7 can turn on", () => expect(clockRealGate(base)).toEqual({ canTurnOn: true, canTurnOff: false, missing: 0 }));
  test("missing items block Ligar", () => expect(clockRealGate({ ...base, approved: 5 })).toMatchObject({ canTurnOn: false, missing: 2 }));
  test("non-owner can do nothing", () => {
    expect(clockRealGate({ ...base, isOwner: false })).toMatchObject({ canTurnOn: false, canTurnOff: false });
    expect(clockRealGate({ ...base, isOwner: false, enabled: true })).toMatchObject({ canTurnOff: false });
  });
  test("Desligar is allowed for the owner even with the checklist incomplete", () =>
    expect(clockRealGate({ approved: 0, total: 7, isOwner: true, enabled: true })).toMatchObject({ canTurnOff: true, canTurnOn: false }));
});

describe("setClockReal action source", () => {
  const body = actions.slice(actions.indexOf("export async function setClockReal"));
  test("uses the session workspace and checks the owner", () => {
    expect(body).toContain("emailSession()");
    expect(body).toContain('s.workspace.role !== "owner"');
    expect(body).toContain("p_ws: s.workspace.id");
    expect(body).toContain('rpc("set_clock_real"');
  });
  test("maps 42501 and 23514", () => {
    expect(body).toContain('"42501"');
    expect(body).toContain('"23514"');
  });
  test("never touches the server env switch", () => expect(actions + ui).not.toContain("process.env"));
});

describe("switch UI source", () => {
  test("confirm step states the risk and the server lock", () => {
    const msgs = readFileSync(path.join(root, "src/messages/pt/email.ts"), "utf8");
    expect(msgs).toContain("O relógio vai enviar e-mails reais sozinho, dentro dos limites; também é preciso o administrador ligar ${SERVER_SWITCH} no servidor.");
    expect(msgs).toContain('"SCHEDULER_" + "REAL_SEND"');
  });
  test("Ligar is gated, Desligar uses canTurnOff", () => {
    expect(ui).toContain("disabled={!gate.canTurnOn || pending}");
    expect(ui).toContain("disabled={!gate.canTurnOff || pending}");
  });
});
