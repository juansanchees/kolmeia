export const PAGE_SIZES = [15, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 15;

/** Bounds of one page; `page` is 1-based and clamped into [1, pages]. */
export function pageBounds(total: number, page: number, size: number = DEFAULT_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (p - 1) * size;
  return { page: p, pages, start, end: Math.min(total, start + size) };
}
