"use client";

import { taskAction } from "@/app/(app)/leads/tarefas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { t } from "@/messages/pt";

export function TaskButtons({ id }: { id: string }) {
  return (
    <span className="flex flex-wrap gap-2">
      <ActionButton action={() => taskAction(id, "postpone")} label={t.tasks.postpone} />
      <ActionButton action={() => taskAction(id, "done")} label={t.tasks.done} variant="primary" />
    </span>
  );
}
