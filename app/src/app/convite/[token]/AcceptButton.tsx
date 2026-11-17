"use client";

import { useActionState } from "react";
import { acceptInviteAction } from "./actions";
import { HexButton, Notice } from "@/components/ui";
import { idle } from "@/lib/form-state";
import { useT } from "@/lib/i18n/client";

export function AcceptButton({ token }: { token: string }) {
  const t = useT();
  const [state, action, pending] = useActionState(() => acceptInviteAction(token), idle);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === "error" && <Notice tone="danger" role="alert">{state.message}</Notice>}
      <HexButton type="submit" disabled={pending} className="w-full">{t.team.accept}</HexButton>
    </form>
  );
}
