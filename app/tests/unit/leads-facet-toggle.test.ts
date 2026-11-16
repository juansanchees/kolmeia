import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FacetPanel, toggle } from "@/components/leads/FacetPanel";
import { DEFAULT_LEAD_FILTERS, leadFacetsOf } from "@/lib/leads/view";

const NAME = "Empreiteiros residenciais (alvarás 12m)";

describe("facet toggle", () => {
  it("on adds once, off removes", () => {
    const on = toggle<string>([], NAME, true);
    expect(on).toEqual([NAME]);
    expect(toggle(on, NAME, true)).toEqual([NAME]);
    expect(toggle(on, NAME, false)).toEqual([]);
  });

  it("a picked origin list renders its checkbox checked, even when no row is counted for it", () => {
    const f = { ...DEFAULT_LEAD_FILTERS, lists: toggle<string>([], NAME, true) };
    const html = (facets: ReturnType<typeof leadFacetsOf>) =>
      renderToStaticMarkup(createElement(FacetPanel, { facets, f, set: () => {}, agents: [], hasOneOff: false }));
    const base = leadFacetsOf([], f);
    expect(html({ ...base, lists: [{ value: NAME, n: 3 }] }).match(/<input[^>]*checked=""/g)).toHaveLength(1);
    expect(html(base).match(/<input[^>]*checked=""/g)).toHaveLength(1);
  });
});
