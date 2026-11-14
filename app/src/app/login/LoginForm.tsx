"use client";

import { useActionState, useState } from "react";
import { authenticate } from "./actions";
import { idle } from "@/lib/form-state";
import { Button, Field, LinkButton, TextInput } from "@/components/ui";
import { t } from "@/messages/pt";

export function LoginForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [state, action, pending] = useActionState(authenticate, idle);
  const signup = mode === "signup";

  return (
    <form action={action} className="flex flex-col gap-5 border border-line bg-surface p-6" noValidate>
      <h1 className="text-3xl">{signup ? t.login.signUpTitle : t.login.title}</h1>
      <input type="hidden" name="mode" value={mode} />
      <Field label={t.login.email} htmlFor="email">
        <TextInput id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label={t.login.password} htmlFor="password" hint={signup ? t.login.passwordHint : undefined}>
        <TextInput
          id="password"
          name="password"
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          minLength={8}
          required
          aria-describedby={signup ? "password-hint" : undefined}
        />
      </Field>
      {state.status === "error" && <p role="alert" className="text-sm text-danger">{state.message}</p>}
      {state.status === "success" && <p role="status" className="border border-blue p-3 text-sm">{state.message}</p>}
      <Button type="submit" disabled={pending}>{signup ? t.login.signUp : t.login.signIn}</Button>
      <LinkButton type="button" onClick={() => setMode(signup ? "signin" : "signup")}>
        {signup ? t.login.switchToSignIn : t.login.switchToSignUp}
      </LinkButton>
    </form>
  );
}
