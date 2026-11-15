import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/configuracoes/fontes/actions", () => ({ deleteSourceKey: vi.fn(), saveSourceCap: vi.fn(), saveSourceKey: vi.fn() }));

import { ConnectionCard } from "@/components/sources/ConnectionCard";
import * as forms from "@/components/email/forms";

describe("controlled forms (React 19 resets uncontrolled inputs after an action)", () => {
  it("cap input renders its current value", () => {
    const html = renderToStaticMarkup(createElement(ConnectionCard, { view: { provider: "apify", last4: "abcd", cap: 7.5, today: 1 }, isOwner: true }));
    expect(html).toMatch(/name="cap"[^>]*value="7.5"|value="7.5"[^>]*name="cap"/);
  });

  it("campaign and suppression selects render a selected value", () => {
    const camp = renderToStaticMarkup(createElement(forms.NewCampaignForm, { lists: [{ id: "l1", name: "A" }, { id: "l2", name: "B" }], mailboxes: [{ id: "m1", email: "a@x.com" }] }));
    expect(camp).toContain('<option value="l1" selected');
    expect(camp).toContain('<option value="m1" selected');
    expect(renderToStaticMarkup(createElement(forms.SuppressionForm))).toContain('<option value="manual" selected');
  });
});
