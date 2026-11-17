"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import {
  addSuppression,
  connectMailbox,
  createCampaign,
  saveSenderProfile,
  setCampaignMailboxes,
  setDelays,
  setMailboxLimit,
  setProspectEmail,
} from "@/app/(app)/campanhas/actions";
import { idle, type FormState } from "@/lib/form-state";
import type { MailboxRow, SenderProfile } from "@/lib/email/types";
import { Field } from "@/components/ui";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { btn, input, Notice } from "./bits";

function FormMessage({ status, message }: { status: string; message?: string }) {
  if (!message) return null;
  return <Notice tone={status === "success" ? "ok" : "warn"} role={status === "success" ? "status" : "alert"}>{message}</Notice>;
}

// ---------------------------------------------------------------- sender profile (R4)
export function SenderForm({ initial, disabled }: { initial: SenderProfile; disabled?: boolean }) {
  const t = useT();
  const M = t.email;
  const [state, action, pending] = useActionState(saveSenderProfile, idle);
  const [v, setV] = useState(initial);
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Field label={M.sender.legalName} htmlFor="legal_name" hint={M.sender.legalNameHint} error={e.legal_name}>
        <input id="legal_name" name="legal_name" className={input} value={v.legal_name} maxLength={120} disabled={disabled} onChange={(x) => setV({ ...v, legal_name: x.target.value })} aria-invalid={Boolean(e.legal_name)} />
      </Field>
      <Field label={M.sender.postalAddress} htmlFor="postal_address" hint={M.sender.postalAddressHint} error={e.postal_address}>
        <textarea id="postal_address" name="postal_address" rows={3} className={input} value={v.postal_address} maxLength={300} disabled={disabled} onChange={(x) => setV({ ...v, postal_address: x.target.value })} aria-invalid={Boolean(e.postal_address)} />
      </Field>
      <Field label={M.sender.senderName} htmlFor="sender_name" hint={M.sender.senderNameHint} error={e.sender_name}>
        <input id="sender_name" name="sender_name" className={input} value={v.sender_name} maxLength={80} disabled={disabled} onChange={(x) => setV({ ...v, sender_name: x.target.value })} aria-invalid={Boolean(e.sender_name)} />
      </Field>
      <FormMessage status={state.status} message={state.message} />
      {!disabled && (
        <div>
          <button type="submit" className={btn.primary} disabled={pending}>
            {M.sender.save}
          </button>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------- connect a Gmail mailbox
export function ConnectMailboxForm() {
  const t = useT();
  const M = t.email;
  const [state, action, pending] = useActionState(connectMailbox, idle);
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate autoComplete="off">
      <Field label={M.mailbox.address} htmlFor="mb_email" error={e.email}>
        <input id="mb_email" name="email" type="email" inputMode="email" autoComplete="off" className={input} placeholder="vendas@suaempresa.com" aria-invalid={Boolean(e.email)} />
      </Field>
      <Field label={M.mailbox.appPassword} htmlFor="mb_password" error={e.password}>
        <input id="mb_password" name="password" type="password" autoComplete="new-password" spellCheck={false} className={input} placeholder="xxxx xxxx xxxx xxxx" aria-invalid={Boolean(e.password)} />
      </Field>
      <FormMessage status={state.status} message={state.message} />
      <div>
        <button type="submit" className={btn.primary} disabled={pending}>
          {pending ? M.mailbox.connecting : M.mailbox.connect}
        </button>
      </div>
    </form>
  );
}

export function MailboxLimitForm({ mailboxId, limit }: { mailboxId: string; limit: number }) {
  const t = useT();
  const M = t.email;
  const router = useRouter();
  const [value, setValue] = useState(String(limit));
  const [msg, setMsg] = useState<{ ok: boolean; text?: string } | null>(null);
  const [pending, start] = useTransition();
  const id = `limit-${mailboxId}`;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        start(async () => {
          const r = await setMailboxLimit(mailboxId, Number(value));
          setMsg({ ok: r.ok, text: r.message ?? (r.ok ? undefined : M.genericError) });
          router.refresh();
        });
      }}
    >
      <label htmlFor={id} className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{M.mailbox.limit}</span>
        <input id={id} type="number" min={1} max={50} step={1} value={value} onChange={(e) => setValue(e.target.value)} className={`${input} w-24`} aria-describedby={`${id}-hint`} />
      </label>
      <button type="submit" className={btn.ghost} disabled={pending}>
        {M.mailbox.saveLimit}
      </button>
      <span id={`${id}-hint`} className="w-full text-[13px] text-muted">
        {M.mailbox.limitHint}
      </span>
      {msg?.text && <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
    </form>
  );
}

// ---------------------------------------------------------------- new campaign
export function NewCampaignForm({ lists, mailboxes }: { lists: { id: string; name: string }[]; mailboxes: { id: string; email: string }[] }) {
  const t = useT();
  const M = t.email;
  const [state, action, pending] = useActionState(createCampaign, idle);
  const [listId, setListId] = useState(lists[0]?.id ?? "");
  const [name, setName] = useState(lists[0]?.name ?? "");
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? "");
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Field label={M.campaigns.list} htmlFor="list_id">
        <select id="list_id" name="list_id" className={input} value={listId} onChange={(e) => { setListId(e.target.value); setName(lists.find((l) => l.id === e.target.value)?.name ?? name); }}>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={M.campaigns.name} htmlFor="camp_name">
        <input id="camp_name" name="name" className={input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={M.campaigns.mailbox} htmlFor="mailbox_id">
        <select id="mailbox_id" name="mailbox_id" className={input} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
          {mailboxes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.email}
            </option>
          ))}
        </select>
      </Field>
      <FormMessage status={state.status} message={state.message} />
      <div>
        <button type="submit" className={btn.primary} disabled={pending}>
          {M.campaigns.create}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- type a missing address (R18: stored as manual)
export function ProspectEmailForm({ prospectId, company }: { prospectId: string; company: string }) {
  const t = useT();
  const M = t.email;
  const router = useRouter();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const id = `email-${prospectId}`;
  return (
    <form
      className="flex min-w-0 flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setProspectEmail(prospectId, value);
          setMsg(r.ok ? null : (r.message ?? M.genericError));
          if (r.ok) setValue("");
          router.refresh();
        });
      }}
    >
      <label htmlFor={id} className="sr-only">
        {`${M.campaign.typeEmail}: ${company}`}
      </label>
      <input id={id} type="email" inputMode="email" value={value} onChange={(e) => setValue(e.target.value)} placeholder={M.campaign.typeEmail} className={`${input} max-w-60 py-1.5 text-sm`} />
      <button type="submit" className={`${btn.ghost} min-h-9 px-3 text-sm`} disabled={pending || !value.trim()}>
        {M.campaign.saveEmail}
      </button>
      {msg && <span role="alert" className="text-sm text-danger">{msg}</span>}
    </form>
  );
}

export function DelaysForm({ campaignId, step2, step3 }: { campaignId: string; step2: number; step3: number }) {
  const t = useT();
  const M = t.email;
  const router = useRouter();
  const [s2, setS2] = useState(String(step2));
  const [s3, setS3] = useState(String(step3));
  const [msg, setMsg] = useState<{ ok: boolean; text?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setDelays(campaignId, Number(s2), Number(s3));
          setMsg({ ok: r.ok, text: r.message });
          router.refresh();
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{M.campaign.step2}</span>
        <input type="number" min={1} max={30} value={s2} onChange={(e) => setS2(e.target.value)} className={`${input} w-24`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{M.campaign.step3}</span>
        <input type="number" min={2} max={60} value={s3} onChange={(e) => setS3(e.target.value)} className={`${input} w-24`} />
      </label>
      <button type="submit" className={btn.ghost} disabled={pending}>
        {M.campaign.saveDelays}
      </button>
      {msg?.text && <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
    </form>
  );
}

export function CampaignMailboxesForm({
  campaignId,
  options,
  selected,
}: {
  campaignId: string;
  options: { id: string; email: string; status: MailboxRow["status"]; sentToday: number }[];
  selected: string[];
}) {
  const t = useT();
  const M = t.email;
  const router = useRouter();
  const [ticked, setTicked] = useState<string[]>(selected);
  const [msg, setMsg] = useState<{ ok: boolean; text?: string } | null>(null);
  const [pending, start] = useTransition();
  const toggle = (id: string) => setTicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setCampaignMailboxes(campaignId, ticked);
          setMsg({ ok: r.ok, text: r.message });
          router.refresh();
        });
      }}
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {options.map((o) => (
          <li key={o.id}>
            <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <input type="checkbox" checked={ticked.includes(o.id)} onChange={() => toggle(o.id)} />
              <span className="break-all">{o.email}</span>
              <span className="text-[13px] text-muted">
                {M.mailbox.statuses[o.status]} · {fill(M.campaign.sentToday, { n: o.sentToday })}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[13px] text-muted">{M.campaign.mailboxesHint}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={btn.ghost} disabled={pending || ticked.length === 0}>
          {M.campaign.saveMailboxes}
        </button>
        {msg?.text && <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- suppressions
export function SuppressionForm() {
  const t = useT();
  const M = t.email;
  const [fields, setFields] = useState({ value: "", reason: "manual", note: "" });
  const [state, action, pending] = useActionState(async (prev: FormState, fd: FormData) => {
    const r = await addSuppression(prev, fd);
    if (r.status === "success") setFields((f) => ({ ...f, value: "", note: "" }));
    return r;
  }, idle);
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Field label={M.blocked.value} htmlFor="sup_value" hint={M.blocked.valueHint} error={e.value}>
        <input id="sup_value" name="value" className={input} maxLength={254} autoComplete="off" value={fields.value} onChange={(ev) => setFields({ ...fields, value: ev.target.value })} aria-invalid={Boolean(e.value)} />
      </Field>
      <Field label={M.blocked.reason} htmlFor="sup_reason">
        <select id="sup_reason" name="reason" className={input} value={fields.reason} onChange={(ev) => setFields({ ...fields, reason: ev.target.value })}>
          <option value="manual">{M.blocked.reasons.manual}</option>
          <option value="asked_to_stop">{M.blocked.reasons.asked_to_stop}</option>
        </select>
      </Field>
      <Field label={M.blocked.note} htmlFor="sup_note">
        <input id="sup_note" name="note" className={input} maxLength={300} value={fields.note} onChange={(ev) => setFields({ ...fields, note: ev.target.value })} />
      </Field>
      <FormMessage status={state.status} message={state.message} />
      <div>
        <button type="submit" className={btn.primary} disabled={pending}>
          {M.blocked.add}
        </button>
      </div>
    </form>
  );
}
