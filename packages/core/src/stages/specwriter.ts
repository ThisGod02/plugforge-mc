import type { ChatMessage } from "../llm/types.ts";
import { specSchema } from "../spec/schema.ts";
import { validateSpec, type PluginSpec } from "../spec/spec.ts";
import { renderAnswers, type Answer } from "./clarifier.ts";
import { plannerSystemMessage, renderPrompt, type LlmContext } from "./context.ts";
import { extractJson } from "./protocol.ts";

const ATTEMPTS = 3;

/**
 * SpecWriter (PLAN.md §6.2): request + answers → spec.json valid against the schema.
 * With `revise`, rewrites an earlier spec according to the user's feedback.
 */
export async function writeSpec(
  ctx: LlmContext,
  input: { request: string; answers: Answer[]; revise?: { spec: PluginSpec; feedback: string } },
): Promise<PluginSpec> {
  const revision = input.revise
    ? `\n## Previous version of the spec\n\`\`\`json\n${JSON.stringify(input.revise.spec, null, 2)}\n\`\`\`\n\n` +
      `## The user asked for these changes\n${input.revise.feedback}\n\nKeep everything the user did not ask to change.\n`
    : "";
  const prompt = await renderPrompt("spec-writer", {
    request: input.request,
    answers: renderAnswers(input.answers),
    revision,
    schema: JSON.stringify(specSchema, null, 2),
  });
  const messages: ChatMessage[] = [await plannerSystemMessage(ctx), { role: "user", content: prompt }];
  for (let attempt = 1; ; attempt++) {
    const reply = await ctx.gateway.chat("spec", messages, { json: true, label: input.revise ? "spec.revise" : "spec" });
    let errors: string[];
    let spec: unknown;
    try {
      spec = extractJson(reply.content);
      errors = validateSpec(spec);
    } catch (err) {
      errors = [`not valid JSON: ${(err as Error).message}`];
    }
    if (errors.length === 0) return spec as PluginSpec;
    ctx.log(`SpecWriter: ${errors.length} problem(s): ${errors.slice(0, 3).join("; ")}`);
    if (attempt >= ATTEMPTS) throw new Error(`SpecWriter could not produce a valid spec:\n  ${errors.join("\n  ")}`);
    messages.push(
      { role: "assistant", content: reply.content },
      { role: "user", content: `The spec is invalid:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nAnswer with the corrected JSON object only.` },
    );
  }
}
