import { describe, expect, test } from "vitest";
import { MAX_CAMPAIGN_MAILBOXES, mailboxListChange, sentTodayByAddress } from "@/lib/email/rotation";
import { localDayStart } from "@/lib/email/schedule";
import { fill, t } from "@/messages/pt";

describe("E3 campaign mailboxes on the screen", () => {
  test("mailboxListChange: removes what was unticked, adds what was ticked, in screen order, without duplicates", () => {
    expect(mailboxListChange(["a", "b", "c"], ["c", "d", "d", "e"])).toEqual({ remove: ["a", "b"], add: ["d", "e"] });
    expect(mailboxListChange([], ["x"])).toEqual({ remove: [], add: ["x"] });
    expect(MAX_CAMPAIGN_MAILBOXES).toBe(10);
  });
  test("sentTodayByAddress counts rows per sending address", () => {
    expect(sentTodayByAddress([{ mailbox_address: "a@x.example" }, { mailbox_address: "b@x.example" }, { mailbox_address: "a@x.example" }])).toEqual({ "a@x.example": 2, "b@x.example": 1 });
  });
  test("localDayStart matches public.local_day_start (DST days and Tokyo)", () => {
    expect(localDayStart("America/New_York", new Date("2026-03-08T12:00:00Z")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(localDayStart("America/New_York", new Date("2026-11-01T12:00:00Z")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(localDayStart("Asia/Tokyo", new Date("2026-11-13T20:00:00Z")).toISOString()).toBe("2026-11-13T15:00:00.000Z");
  });
  test("pt-BR texts", () => {
    expect(t.email.campaign.mailboxes).toBe("Caixas desta campanha");
    expect(fill(t.email.campaign.sentToday, { n: 3 })).toBe("enviados hoje: 3");
    expect(t.email.campaign.mailboxesError).toBe("Escolha de 1 a 10 caixas deste espaço.");
    expect(t.email.campaign.mailboxesMax).toBe("Uma campanha pode ter no máximo 10 caixas.");
    expect(t.email.campaign.mailboxesHint).toBe("Quem já recebeu e-mail continua sempre na mesma caixa. Se você tirar uma caixa da campanha, os próximos e-mails dessas pessoas esperam até ela voltar.");
  });
});
