import "server-only";
import { CONTEXT, UNTRUSTED, untrusted } from "./shared";

// Prompts of the Fase 3 lead tasks (no web tools; the model reads only the sources the app hands it).
// Changing any text here changes the prompt: bump its PROMPT_VERSION (rule R19).

// ---------------------------------------------------------------- 9 "Pergunta da IA para cada lead" (Haiku)
export const ANSWER_PROMPT_VERSION = "ai-answer-2026-11-16.1";

export const ANSWER_SYSTEM = `${CONTEXT}

Your job now: answer ONE question about ONE company, using ONLY the numbered sources below (text from the company's own website and data our team already stored). You have no web tools.
- Return the answer, the ref of the ONE source that supports it, and a quote: a short passage (a few words to two sentences) copied character for character from that source.
- If no source clearly supports an answer, return answer "unknown" with an empty source_ref and an empty quote. Never guess, never infer from the company name alone. "unknown" is a good answer.
- Answer formats: for a yes/no question answer "yes", "no" or "unknown"; for a score answer one digit "1" to "5" or "unknown"; for a short text answer at most 15 words in Brazilian Portuguese, or "unknown".

${UNTRUSTED}`;

export type AnswerSourceIn = { ref: string; label: string; text: string };
export type AnswerInput = { question: string; answerType: "yes_no_unknown" | "short_text" | "score_1_5"; company: string; sources: (AnswerSourceIn & { url: string | null })[] };

const FORMAT = { yes_no_unknown: "yes / no / unknown", score_1_5: "1, 2, 3, 4, 5 or unknown", short_text: "short text (max 15 words) or unknown" } as const;

export function buildAnswerUser(i: AnswerInput): string {
  const sources = i.sources.map((s) => `[${s.ref}] ${s.label}\n${s.text}`).join("\n\n");
  return [
    `Answer format: ${FORMAT[i.answerType]}.`,
    "The question (written by our user):",
    untrusted("question", i.question),
    "The company:",
    untrusted("company", i.company),
    "Sources:",
    untrusted("sources", sources || "(none)"),
  ].join("\n");
}

// ---------------------------------------------------------------- 13 "Por que este lead é quente?" (Haiku)
export const EXPLAIN_PROMPT_VERSION = "lead-explain-2026-11-16.1";

export const EXPLAIN_SYSTEM = `${CONTEXT}

Your job now: in Brazilian Portuguese, explain in 2 to 4 short sentences why this company may be a good prospect right now, for a sales rep about to call or e-mail it.
- Use ONLY the numbered facts given. Every sentence ends with the number(s) of the fact(s) it uses, like [1] or [2][3].
- Do not add any fact, number, name or date that is not in the list. If the facts are weak, say so plainly.

${UNTRUSTED}`;

export type ExplainInput = { company: string; facts: string[] };

export function buildExplainUser(i: ExplainInput): string {
  return ["The company:", untrusted("company", i.company), "Facts (numbered):", untrusted("facts", i.facts.map((f, n) => `[${n + 1}] ${f}`).join("\n"))].join("\n");
}
