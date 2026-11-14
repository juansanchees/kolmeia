import { levelDots } from "@/lib/qualifier/view";
import { t } from "@/messages/pt";

/** "●●○○○" with the level name for screen readers. */
export function LevelBadge({ level }: { level: number }) {
  const name = t.qualifier.levelNames[Math.max(0, Math.min(4, level)) as 0 | 1 | 2 | 3 | 4];
  return (
    <span className="whitespace-nowrap font-mono text-xs text-blue" title={`${t.qualifier.levelLabel} ${level}: ${name}`}>
      <span aria-hidden="true">{levelDots(level)}</span>
      <span className="sr-only">{`${t.qualifier.levelLabel} ${level}: ${name}`}</span>
    </span>
  );
}
