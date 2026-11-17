import type { ai as pt } from "../pt/ai";
import type { Widen } from "../widen";

export const ai = {
  notConfigured: "AI not configured. The Anthropic key is missing on the server (see the product README). The rest of the app works normally.",
  noAccess: "Your AI access has not been enabled yet.",
  userCap: "Your personal daily AI spend cap was reached. Research is paused; continue tomorrow.",
  globalCap: "The system daily AI spend cap was reached. Research is paused; continue tomorrow.",
  runTime: "This research ran out of time. It stopped and delivered what it had, marked as partial.",
  dailyCap: "This workspace's daily AI spend cap was reached. Research is paused; continue tomorrow or ask the owner to raise the cap.",
  runCap: "This research hit its cost cap. It stopped and delivered what it had, marked as partial.",
  qualifierDaily: "The Qualifier's daily cap was reached. It resumes on its own at midnight (New York time).",
  leadCap: "This lead hit the Qualifier's spend cap. It stopped there.",
  refused: "The AI refused this request. Rewrite it and try again.",
  invalidOutput: "The AI returned an answer in an unexpected format. We will try again on the next step.",
  truncated: "The AI answer was cut off before the end. We will try again on the next step.",
  generic: "Could not reach the AI. We will try again on the next step.",
  suggestion: "AI suggestion",
} satisfies Widen<typeof pt>;
