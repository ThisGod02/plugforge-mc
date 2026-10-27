import type { ChatMessage } from "../llm/types.ts";
import { plannerSystemMessage, renderPrompt, type LlmContext } from "./context.ts";
import { extractJson } from "./protocol.ts";

export interface ClarifyQuestion {
  id: string;
  question: string;
  /** First option is the recommended default. */
  options: string[];
}

export interface Answer {
  question: string;
  answer: string;
}

const MAX_QUESTIONS = 5;

/** "## Clarifications"-style list of earlier answers, or "(none)". */
export function renderAnswers(answers: Answer[]): string {
  return answers.length ? answers.map((a) => `- ${a.question}\n  → ${a.answer}`).join("\n") : "(none)";
}

function checkQuestions(raw: unknown): ClarifyQuestion[] {
  const list = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list)) throw new Error('expected {"questions": [...]}');
  const out: ClarifyQuestion[] = [];
  for (const [i, q] of (list as { id?: unknown; question?: unknown; options?: unknown }[]).entries()) {
    if (typeof q?.question !== "string" || !q.question.trim()) throw new Error(`question #${i + 1} has no text`);
    const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
    if (options.length < 2) throw new Error(`question "${q.question}" needs at least 2 options`);
    out.push({ id: typeof q.id === "string" && q.id ? q.id : `q${i + 1}`, question: q.question.trim(), options: options.slice(0, 4) });
  }
  return out.slice(0, MAX_QUESTIONS);
}

/**
 * Clarifier (PLAN.md §6.1): questions with options, or none when the request is clear.
 * The caller runs at most two rounds; answers of round one are passed back in round two.
 */
export async function clarify(ctx: LlmContext, request: string, previous: Answer[]): Promise<ClarifyQuestion[]> {
  const prompt = await renderPrompt("clarifier", {
    request,
    previous: previous.length
      ? `\n## Already answered (round 2: ask only what is still unclear after these, usually nothing)\n${renderAnswers(previous)}\n`
      : "",
    maxQuestions: String(previous.length ? 3 : MAX_QUESTIONS),
  });
  const messages: ChatMessage[] = [await plannerSystemMessage(ctx), { role: "user", content: prompt }];
  for (let attempt = 1; ; attempt++) {
    const reply = await ctx.gateway.chat("clarify", messages, { json: true, label: `clarify.round${previous.length ? 2 : 1}` });
    try {
      return checkQuestions(extractJson(reply.content));
    } catch (err) {
      if (attempt >= 2) throw new Error(`Clarifier gave an unusable answer: ${(err as Error).message}`);
      messages.push({ role: "assistant", content: reply.content }, { role: "user", content: `Invalid answer: ${(err as Error).message}. Answer with corrected JSON only.` });
    }
  }
}
