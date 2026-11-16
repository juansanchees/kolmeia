// "Pergunta da IA para cada lead" (Fase 3, item 9, migration 0029). Client-safe vocabulary and rules.

export const ANSWER_TYPES = ["yes_no_unknown", "short_text", "score_1_5"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
export const QUESTION_SOURCES = ["site", "data"] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];
export const QUESTION_MAX = 300;
/** Most leads one "Testar" runs synchronously. */
export const TEST_LEADS = 3;
/** Most leads one "Rodar em N" queues. */
export const RUN_MAX = 500;

export type AiQuestion = { id: string; question: string; answer_type: AnswerType; sources: QuestionSource[]; created_at: string };
export const QUESTION_COLUMNS = "id, question, answer_type, sources, created_at";

export type AnswerStatus = "queued" | "done" | "failed" | "skipped";
/** One lead's answer to one question as the list shows it. `answer` is "unknown" for "Não sei". */
export type AiCell = { status: AnswerStatus; answer: string | null; url: string | null; excerpt: string | null; label: string | null };

/** Answer filter values: a concrete answer, "unknown", "answered" (anything but unknown) or "pending" (no finished answer). */
export function answerFilterValues(type: AnswerType): string[] {
  if (type === "yes_no_unknown") return ["yes", "no", "unknown", "pending"];
  if (type === "score_1_5") return ["1", "2", "3", "4", "5", "unknown", "pending"];
  return ["answered", "unknown", "pending"];
}

/** Whether a lead's cell passes the answer filter ("all" passes everything). */
export function matchesAnswer(cell: AiCell | undefined, want: string): boolean {
  if (want === "all" || want === "") return true;
  const done = cell?.status === "done" && cell.answer !== null;
  if (want === "pending") return !done;
  if (!done) return false;
  if (want === "answered") return cell!.answer !== "unknown";
  return cell!.answer === want;
}
