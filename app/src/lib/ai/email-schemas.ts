import "server-only";
import { z } from "zod";
import { REPLY_CLASSES } from "@/lib/email/types";

// Structured-output schemas of the E-mail area (same conventions as ./schemas.ts: no optionals or nullables).

export const draftSchema = z.object({
  emails: z.array(z.object({ step: z.number(), subject: z.string(), body: z.string() })),
  facts_used: z.array(z.string()),
  no_fact: z.boolean(),
});

export const classifySchema = z.object({
  classification: z.enum(REPLY_CLASSES),
  reason: z.string(),
});

export const replyDraftSchema = z.object({ body: z.string() });

export const briefSchema = z.object({
  who: z.string(),
  what_they_said: z.string(),
  next_step: z.string(),
  evidence_urls: z.array(z.string()),
});

export type DraftOut = z.infer<typeof draftSchema>;
export type ClassifyOut = z.infer<typeof classifySchema>;
export type ReplyDraftOut = z.infer<typeof replyDraftSchema>;
export type BriefOut = z.infer<typeof briefSchema>;
