"use client";

import { levelDots } from "@/lib/qualifier/view";
import { useT } from "@/lib/i18n/client";

/** "●●○○○" with the level name for screen readers. */
export function LevelBadge({ level }: { level: number }) {
  const t = useT();
  const name = t.qualifier.levelNames[Math.max(0, Math.min(4, level)) as 0 | 1 | 2 | 3 | 4];
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-honey-pill px-2.5 py-0.5 font-mono text-sm tracking-wider text-[#7a4e00]" title={`${t.qualifier.levelLabel} ${level}: ${name}`}>
      <span aria-hidden="true">{levelDots(level)}</span>
      <span className="sr-only">{`${t.qualifier.levelLabel} ${level}: ${name}`}</span>
    </span>
  );
}
