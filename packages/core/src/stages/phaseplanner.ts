import type { ChatMessage } from "../llm/types.ts";
import { renderAnswers, type Answer } from "./clarifier.ts";
import { plannerSystemMessage, renderPrompt, type LlmContext } from "./context.ts";
import { extractJson } from "./protocol.ts";

export interface PhasePlanItem {
  title: string;
  /** What the phase adds, concretely; SpecWriter turns it into criteria. */
  goal: string;
}

export const MAX_PHASES = 6;

function checkPlan(raw: unknown): PhasePlanItem[] {
  const list = (raw as { phases?: unknown })?.phases;
  if (!Array.isArray(list) || list.length === 0) throw new Error('expected {"phases": [{"title", "goal"}, ...]}');
  if (list.length > MAX_PHASES) throw new Error(`at most ${MAX_PHASES} phases`);
  return (list as { title?: unknown; goal?: unknown }[]).map((p, i) => {
    if (typeof p?.title !== "string" || !p.title.trim() || typeof p.goal !== "string" || !p.goal.trim()) {
      throw new Error(`phase ${i + 1} needs a title and a goal`);
    }
    return { title: p.title.trim(), goal: p.goal.trim() };
  });
}

/** Splits a request into build phases (one for small plugins). With `revise`, reworks a plan by the user's feedback. */
export async function planPhases(
  ctx: LlmContext,
  input: { request: string; answers: Answer[]; revise?: { plan: PhasePlanItem[]; feedback: string } },
): Promise<PhasePlanItem[]> {
  const revision = input.revise
    ? `\n## Previous plan\n${renderPlan(input.revise.plan)}\n\n## The user asked for these changes\n${input.revise.feedback}\n`
    : "";
  const prompt = await renderPrompt("phase-planner", { request: input.request, answers: renderAnswers(input.answers), revision, max: String(MAX_PHASES) });
  const messages: ChatMessage[] = [await plannerSystemMessage(ctx), { role: "user", content: prompt }];
  for (let attempt = 1; ; attempt++) {
    const reply = await ctx.gateway.chat("spec", messages, { json: true, label: input.revise ? "phases.revise" : "phases" });
    try {
      return checkPlan(extractJson(reply.content));
    } catch (err) {
      if (attempt >= 2) throw new Error(`could not plan the build phases: ${(err as Error).message}`);
      messages.push({ role: "assistant", content: reply.content }, { role: "user", content: `Invalid plan: ${(err as Error).message}. Answer with corrected JSON only.` });
    }
  }
}

export function renderPlan(plan: PhasePlanItem[], current?: number): string {
  return plan
    .map((p, i) => `${i + 1}. ${p.title} — ${p.goal}${current === undefined ? "" : i < current ? "  (built and tested)" : i === current ? "  ← THIS PHASE" : "  (later)"}`)
    .join("\n");
}
