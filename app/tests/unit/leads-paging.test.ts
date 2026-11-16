import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, pageBounds } from "@/lib/leads/paging";

describe("pageBounds", () => {
  it("defaults to 15 per page and offers 15/20/50/100", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(15);
    expect([...PAGE_SIZES]).toEqual([15, 20, 50, 100]);
    expect(pageBounds(881, 1)).toEqual({ page: 1, pages: 59, start: 0, end: 15 });
  });
  it("slices 881 items at 15 and 100", () => {
    expect(pageBounds(881, 59, 15)).toEqual({ page: 59, pages: 59, start: 870, end: 881 });
    expect(pageBounds(881, 9, 100)).toEqual({ page: 9, pages: 9, start: 800, end: 881 });
  });
  it("clamps the page when the set shrinks or the input is junk", () => {
    expect(pageBounds(20, 9, 15)).toMatchObject({ page: 2, start: 15, end: 20 });
    expect(pageBounds(0, 5)).toEqual({ page: 1, pages: 1, start: 0, end: 0 });
    expect(pageBounds(50, 0).page).toBe(1);
    expect(pageBounds(50, NaN).page).toBe(1);
  });
});
