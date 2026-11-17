"use client";

import { Children, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, pageBounds } from "@/lib/paging";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

const btnCls = "min-h-11 border border-blue bg-surface px-4 text-sm font-semibold text-blue hover:bg-blue-wash disabled:opacity-40";

/** Client-side paging: always starts at 15 per page; page 1 again whenever `resetKey` changes. */
export function usePaged<T>(items: T[], resetKey = "") {
  const [s, setS] = useState({ page: 1, size: DEFAULT_PAGE_SIZE, key: resetKey });
  if (s.key !== resetKey) setS({ page: 1, size: s.size, key: resetKey });
  const pb = pageBounds(items.length, s.page, s.size);
  const pageItems = useMemo(() => items.slice(pb.start, pb.end), [items, pb.start, pb.end]);
  const pager: PagerState = { ...pb, total: items.length, size: s.size, setPage: (page) => setS((x) => ({ ...x, page })), setSize: (size) => setS((x) => ({ ...x, page: 1, size })) };
  return { pageItems, pager };
}

export type PagerState = ReturnType<typeof pageBounds> & { total: number; size: number; setPage: (p: number) => void; setSize: (n: number) => void };

/** Hidden while everything fits in the smallest page. */
export function Pager({ pager: p }: { pager: PagerState }) {
  const t = useT();
  const P = t.paging;
  if (p.total <= PAGE_SIZES[0]) return null;
  return (
    <nav aria-label={P.label} className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-mono text-xs text-muted">{fill(P.showing, { from: p.start + 1, to: p.end, total: p.total })}</span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          {P.perPage}
          <select aria-label={P.perPage} value={p.size} onChange={(e) => p.setSize(Number(e.target.value))} className="min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <button type="button" aria-label={P.prev} disabled={p.page <= 1} onClick={() => p.setPage(p.page - 1)} className={btnCls}>{P.prev}</button>
        <span className="font-mono text-xs text-muted">{fill(P.page, { page: p.page, pages: p.pages })}</span>
        <button type="button" aria-label={P.next} disabled={p.page >= p.pages} onClick={() => p.setPage(p.page + 1)} className={btnCls}>{P.next}</button>
      </div>
    </nav>
  );
}

/** Pages server-rendered rows: `<Paged as="ul" className="..">{rows.map(..)}</Paged>`. Rows need keys. */
export function Paged({ as: Tag = "div", className, resetKey, children }: { as?: "ul" | "div"; className?: string; resetKey?: string; children: ReactNode }) {
  const { pageItems, pager } = usePaged(Children.toArray(children), resetKey);
  return (
    <>
      <Tag className={className}>{pageItems}</Tag>
      <Pager pager={pager} />
    </>
  );
}

/** Same for a server-rendered table body (`head` = the header rows). */
export function PagedTable({ head, className, wrapClassName, resetKey, children }: { head: ReactNode; className?: string; wrapClassName?: string; resetKey?: string; children: ReactNode }) {
  const { pageItems, pager } = usePaged(Children.toArray(children), resetKey);
  return (
    <>
      <div className={wrapClassName}>
        <table className={className}>
          <thead>{head}</thead>
          <tbody>{pageItems}</tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </>
  );
}
