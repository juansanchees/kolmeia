"use client";

import { useActionState } from "react";
import { acceptInviteAction } from "./actions";
import { Button } from "@/components/ui";
import { idle } from "@/lib/form-state";
import { t } from "@/messages/pt";

export function AcceptButton({ token }: { token: string }) {
  const [state, action, pending] = useActionState(() => acceptInviteAction(token), idle);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === "error" && <p role="alert" className="text-sm text-danger">{state.message}</p>}
      <Button type="submit" disabled={pending}>{t.team.accept}</Button>
    </form>
  );
}
