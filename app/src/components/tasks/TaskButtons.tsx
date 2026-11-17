"use client";

import { taskAction } from "@/app/(app)/leads/tarefas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { useT } from "@/lib/i18n/client";

export function TaskButtons({ id }: { id: string }) {
  const t = useT();
  return (
    <span className="flex flex-wrap gap-2">
      <ActionButton action={() => taskAction(id, "postpone")} label={t.tasks.postpone} />
      <ActionButton action={() => taskAction(id, "done")} label={t.tasks.done} variant="primary" />
    </span>
  );
}
