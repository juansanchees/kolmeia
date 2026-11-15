import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/leads/subir/actions", () => ({ undoImportAction: vi.fn() }));
vi.mock("@/app/(app)/leads/perfil/actions", () => ({ trainProfileAction: vi.fn() }));

import { ImportHistory } from "@/components/imports/ImportHistory";
import { TrainButton } from "@/components/profile/TrainButton";
import type { ImportListItem } from "@/lib/imports/store";

const item: ImportListItem = {
  id: "imp-1", list_name: "Example list", file_name: "example.xlsx", status: "done",
  row_count: 3, new_count: 3, merged_count: 0, error_count: 0, use_as_training: true, created_at: "2026-01-01T00:00:00Z",
};
const links = (html: string) => html.match(/href="\/leads\/perfil\/[^"]+"/g) ?? [];

describe("learned-profile link", () => {
  it("shows exactly one link when the server knows the profile", () => {
    const html = renderToStaticMarkup(createElement(ImportHistory, { items: [item], profiles: { "imp-1": "prof-1" }, trainEstimateUsd: 0.1 }));
    expect(links(html)).toEqual(['href="/leads/perfil/prof-1"']);
  });

  it("shows none before training and one after reload data", () => {
    expect(links(renderToStaticMarkup(createElement(ImportHistory, { items: [item] })))).toEqual([]);
    expect(links(renderToStaticMarkup(createElement(TrainButton, { importId: "imp-1", estimateUsd: 0.1, knownProfileId: "prof-2" })))).toEqual(['href="/leads/perfil/prof-2"']);
  });
});
