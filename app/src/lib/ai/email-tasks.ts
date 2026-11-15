import "server-only";
import { z } from "zod";
import { bodyProblem, hasLink, stripLinks, stripReplyPrefix, subjectProblem } from "@/lib/email/compose";
import type { ReplyClass } from "@/lib/email/types";
import { stepProblems, type SequenceStep } from "@/lib/email/template";
import { sanitizeUrl } from "@/lib/safe-url";
import {
  briefSchema,
  classifySchema,
  draftSchema,
  replyDraftSchema,
  type BriefOut,
  type ClassifyOut,
  type DraftOut,
  type ReplyDraftOut,
} from "./email-schemas";
import { AiError } from "./errors";
import { runTask, type AiContext, type TaskDef, type TaskResult } from "./gateway";
import { MODELS } from "./models";
import * as P from "./prompts/email";
import * as SEQ from "./prompts/email-sequence";

// One typed function per E-mail AI task, all through the gateway (caps R16, ledger R17, validation R15).
// Everything returned here is a proposal: drafts start as status 'draft' and need a human approval (R1, R13).

const clip = (s: string, max: number) => s.replace(/\s+$/g, "").trim().slice(0, max).trim();
const oneLine = (s: string, max: number) => clip(s.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " "), max);

// ---------------------------------------------------------------- sequence draft
export type DraftedEmail = { step: 1 | 2 | 3; subject: string; body: string };
export type DraftResult = { emails: DraftedEmail[]; factsUsed: string[]; noFact: boolean; model: string; promptVersion: string };

/** Cleans one AI e-mail: no fake reply prefix (R4), no links (R12), bounded. Null when nothing valid is left. */
export function cleanDraftEmail(subject: string, body: string): { subject: string; body: string } | null {
  const s = oneLine(stripReplyPrefix(subject), 120);
  const b = clip(stripLinks(body.replace(/\r\n?/g, "\n")).replace(/\n{3,}/g, "\n\n"), 2000);
  if (subjectProblem(s) || bodyProblem(b)) return null;
  return { subject: s, body: b };
}

const draftDef: TaskDef<P.DraftInput, DraftOut, DraftResult> = {
  task: "email_draft",
  model: MODELS.sonnet,
  promptVersion: P.DRAFT_PROMPT_VERSION,
  system: P.DRAFT_SYSTEM,
  schema: draftSchema,
  effort: "medium",
  maxTokens: 16_000,
  reserveUsd: 0.05,
  buildUser: P.buildDraftUser,
  normalize: (p) => {
    const emails: DraftedEmail[] = [];
    for (const step of [1, 2, 3] as const) {
      const raw = p.emails.find((e) => e.step === step);
      const clean = raw ? cleanDraftEmail(raw.subject, raw.body) : null;
      if (clean) emails.push({ step, ...clean });
    }
    return {
      emails,
      factsUsed: p.facts_used.map((f) => oneLine(f, 200)).filter(Boolean).slice(0, 8),
      noFact: p.no_fact,
      model: MODELS.sonnet,
      promptVersion: P.DRAFT_PROMPT_VERSION,
    };
  },
};

export function draftSequence(ctx: AiContext, input: P.DraftInput): Promise<TaskResult<DraftResult>> {
  return runTask(ctx, draftDef, input);
}

// ---------------------------------------------------------------- reply classification
export type ClassifyResult = { classification: ReplyClass; reason: string; model: string };

const classifyDef: TaskDef<P.ClassifyInput, ClassifyOut, ClassifyResult> = {
  task: "email_classify",
  model: MODELS.haiku,
  promptVersion: P.CLASSIFY_PROMPT_VERSION,
  system: P.CLASSIFY_SYSTEM,
  schema: classifySchema,
  effort: "low",
  maxTokens: 4_000,
  reserveUsd: 0.005,
  buildUser: P.buildClassifyUser,
  normalize: (p) => ({ classification: p.classification, reason: oneLine(p.reason, 300), model: MODELS.haiku }),
};

export function classifyReply(ctx: AiContext, input: P.ClassifyInput): Promise<TaskResult<ClassifyResult>> {
  return runTask(ctx, classifyDef, input);
}

// ---------------------------------------------------------------- answer to a reply
export type ReplyDraftResult = { body: string; model: string; promptVersion: string };

const replyDef: TaskDef<P.ReplyDraftInput, ReplyDraftOut, ReplyDraftResult> = {
  task: "email_reply_draft",
  model: MODELS.sonnet,
  promptVersion: P.REPLY_PROMPT_VERSION,
  system: P.REPLY_SYSTEM,
  schema: replyDraftSchema,
  effort: "medium",
  maxTokens: 8_000,
  reserveUsd: 0.03,
  buildUser: P.buildReplyUser,
  normalize: (p) => ({
    body: clip(stripLinks(p.body.replace(/\r\n?/g, "\n")).replace(/\n{3,}/g, "\n\n"), 2000),
    model: MODELS.sonnet,
    promptVersion: P.REPLY_PROMPT_VERSION,
  }),
};

export function draftReply(ctx: AiContext, input: P.ReplyDraftInput): Promise<TaskResult<ReplyDraftResult>> {
  return runTask(ctx, replyDef, input);
}

// ---------------------------------------------------------------- closer brief
export type BriefResult = { who: string; what_they_said: string; next_step: string; evidence_urls: string[]; model: string };

const briefDef: TaskDef<P.BriefInput, BriefOut, BriefResult> = {
  task: "email_closer_brief",
  model: MODELS.opus,
  promptVersion: P.BRIEF_PROMPT_VERSION,
  system: P.BRIEF_SYSTEM,
  schema: briefSchema,
  effort: "medium",
  maxTokens: 16_000,
  reserveUsd: 0.08,
  buildUser: P.buildBriefUser,
  normalize: (p, input) => {
    // Only URLs that were in the evidence we gave (R15, R18): the model cannot add a link of its own.
    const known = new Set(input.evidence.map((e) => sanitizeUrl(e.url)).filter(Boolean));
    const urls = p.evidence_urls.map((u) => sanitizeUrl(u)).filter((u): u is string => Boolean(u) && known.has(u!));
    return {
      who: clip(p.who, 600),
      what_they_said: clip(p.what_they_said, 800),
      next_step: clip(p.next_step, 400),
      evidence_urls: [...new Set(urls)].slice(0, 4),
      model: MODELS.opus,
    };
  },
};

export function writeCloserBrief(ctx: AiContext, input: P.BriefInput): Promise<TaskResult<BriefResult>> {
  return runTask(ctx, briefDef, input);
}

// ---------------------------------------------------------------- sequence template (Sonnet, one call per click)
export type SequenceDraft = { steps: SequenceStep[]; model: string; promptVersion: string };

const sequenceSchema = z.object({ steps: z.array(z.object({ step: z.number(), subject: z.string(), body: z.string() })) });

/** One template for many companies (D2): the model gets audience data only, never one lead; no web tools. */
export const sequenceDef: TaskDef<SEQ.SequenceInput, z.infer<typeof sequenceSchema>, SequenceDraft> = {
  task: "email_sequence",
  model: MODELS.sonnet,
  promptVersion: SEQ.PROMPT_VERSION,
  system: SEQ.SYSTEM,
  schema: sequenceSchema,
  effort: "medium",
  maxTokens: 6_000,
  reserveUsd: 0.05,
  buildUser: SEQ.buildUser,
  normalize: (p, input) => {
    const steps: SequenceStep[] = [];
    for (const step of [1, 2, 3] as const) {
      if (step > input.steps) break;
      const raw = p.steps.find((s) => s.step === step);
      // A link in the subject drops the step; links in the body are stripped (R12, same as the draft writer).
      if (!raw || hasLink(raw.subject)) continue;
      const clean = cleanDraftEmail(raw.subject, raw.body);
      if (!clean) continue;
      const s: SequenceStep = { step, ...clean };
      if (stepProblems(s).length === 0) steps.push(s);
    }
    if (steps.length < input.steps) throw new AiError("invalid_output", `only ${steps.length} of ${input.steps} steps were valid`);
    return { steps, model: MODELS.sonnet, promptVersion: SEQ.PROMPT_VERSION };
  },
};

export function writeSequence(ctx: AiContext, input: SEQ.SequenceInput): Promise<TaskResult<SequenceDraft>> {
  return runTask(ctx, sequenceDef, input);
}
