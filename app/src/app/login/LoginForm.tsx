"use client";

import { useActionState, useState } from "react";
import { authenticate } from "./actions";
import { idle } from "@/lib/form-state";
import { Button, Field, LinkButton, Notice, TextInput } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

export function LoginForm({ next = "/" }: { next?: string }) {
  const t = useT();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [state, action, pending] = useActionState(authenticate, idle);
  const signup = mode === "signup";

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-4xl">{signup ? t.login.signUpTitle : t.login.title}</h1>
        <p className="m-0 text-lg text-[#4a5361]">{signup ? t.login.signUpIntro : t.login.intro}</p>
      </div>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="next" value={next} />
      <Field label={t.login.email} htmlFor="email">
        <TextInput id="email" name="email" type="email" autoComplete="email" required className="min-h-14! text-[17px]!" />
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
          className="min-h-14! text-[17px]!"
        />
      </Field>
      {state.status === "error" && <Notice tone="danger" role="alert">{state.message}</Notice>}
      {state.status === "success" && <Notice tone="info">{state.message}</Notice>}
      <Button type="submit" disabled={pending} className="min-h-14! text-[17px]!">{signup ? t.login.signUp : t.login.signIn}</Button>
      <LinkButton type="button" onClick={() => setMode(signup ? "signin" : "signup")} className="self-center">
        {signup ? t.login.switchToSignIn : t.login.switchToSignUp}
      </LinkButton>
    </form>
  );
}
