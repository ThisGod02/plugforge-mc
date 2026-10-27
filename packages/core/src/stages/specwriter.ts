import type { ChatMessage } from "../llm/types.ts";
import { specSchema } from "../spec/schema.ts";
import { validateSpec, type PluginSpec } from "../spec/spec.ts";
import { renderAnswers, type Answer } from "./clarifier.ts";
import { plannerSystemMessage, renderPrompt, type LlmContext } from "./context.ts";
import { renderPlan, type PhasePlanItem } from "./phaseplanner.ts";
import { extractJson } from "./protocol.ts";

const ATTEMPTS = 3;
/** New acceptance criteria per phase (or per single-phase spec). */
export const MAX_NEW_CRITERIA = 15;

export interface PhaseInfo {
  /** 0-based. */
  index: number;
  plan: PhasePlanItem[];
}

/**
 * What a phase's spec must keep from the previous phase's: same plugin, every criterion with id
 * and text unchanged (its tests stay as regression), and the commands, permissions, config,
 * menus and messages those criteria rely on.
 */
export function extensionErrors(prev: PluginSpec, next: PluginSpec): string[] {
  const errors: string[] = [];
  for (const k of ["name", "package", "mainClass"] as const) if (prev[k] !== next[k]) errors.push(`${k} must stay '${prev[k]}'`);
  const ac = new Map(next.acceptance.map((a) => [a.id, a.text]));
  for (const a of prev.acceptance) {
    if (!ac.has(a.id)) errors.push(`acceptance ${a.id} of the previous phase is missing; keep it unchanged`);
    else if (ac.get(a.id) !== a.text) errors.push(`acceptance ${a.id} text changed; keep it exactly: "${a.text}"`);
  }
  const names = (xs: { name: string }[] | undefined) => new Set((xs ?? []).map((x) => x.name));
  for (const c of prev.commands) if (!names(next.commands).has(c.name)) errors.push(`command '${c.name}' of the previous phase is missing`);
  const nodes = new Set((next.permissions ?? []).map((p) => p.node));
  for (const p of prev.permissions ?? []) if (!nodes.has(p.node)) errors.push(`permission '${p.node}' of the previous phase is missing`);
  const keys = new Set((next.config ?? []).map((c) => c.key));
  for (const c of prev.config ?? []) if (!keys.has(c.key)) errors.push(`config key '${c.key}' of the previous phase is missing`);
  const guis = new Map((next.guis ?? []).map((g) => [g.id, g]));
  for (const g of prev.guis ?? []) {
    const n = guis.get(g.id);
    if (!n) errors.push(`menu '${g.id}' of the previous phase is missing`);
    else if (n.title !== g.title) errors.push(`menu '${g.id}' title changed; keep "${g.title}"`);
  }
  for (const [k, v] of Object.entries(prev.messages ?? {})) {
    if (next.messages?.[k] === undefined) errors.push(`message '${k}' of the previous phase is missing`);
    else if (next.messages[k] !== v) errors.push(`message '${k}' changed; keep it exactly: "${v}"`);
  }
  const added = next.acceptance.length - prev.acceptance.length;
  if (added < 1) errors.push("this phase must add at least one acceptance criterion");
  return errors;
}

function phaseSection(phase: PhaseInfo | undefined, previous: PluginSpec | undefined): string {
  if (!phase || phase.plan.length < 2) return "";
  const k = phase.index + 1;
  let out =
    `\n## Build phases\nThis plugin is built in ${phase.plan.length} phases:\n${renderPlan(phase.plan, phase.index)}\n\n` +
    `Write the spec of the plugin as it is at the END of phase ${k}: everything phases 1-${k} deliver, nothing from later phases.\n`;
  if (previous) {
    const next = previous.acceptance.length + 1;
    out +=
      `\n## Spec at the end of phase ${k - 1} (built and tested)\n\`\`\`json\n${JSON.stringify(previous, null, 2)}\n\`\`\`\n\n` +
      "Keep everything in it: the same name, package and mainClass; every command, permission, config key, menu (with its title) and message unchanged; " +
      `every acceptance criterion with its id and text exactly as it is (their tests already exist). Add what phase ${k} brings: new commands, ` +
      `subcommand forms, permissions, config, menus, messages and assumptions. Number the new criteria from AC${next}.\n`;
  }
  return out;
}

/**
 * SpecWriter (PLAN.md §6.2): request + answers → spec.json valid against the schema. In a phased
 * build it writes the cumulative spec for one phase on top of the previous one; with `revise`,
 * rewrites a spec according to the user's feedback.
 */
export async function writeSpec(
  ctx: LlmContext,
  input: { request: string; answers: Answer[]; revise?: { spec: PluginSpec; feedback: string }; phase?: PhaseInfo; previous?: PluginSpec },
): Promise<PluginSpec> {
  const revision = input.revise
    ? `\n## Previous version of this spec\n\`\`\`json\n${JSON.stringify(input.revise.spec, null, 2)}\n\`\`\`\n\n` +
      `## The user asked for these changes\n${input.revise.feedback}\n\nKeep everything the user did not ask to change.\n`
    : "";
  const prompt = await renderPrompt("spec-writer", {
    request: input.request,
    answers: renderAnswers(input.answers),
    phase: phaseSection(input.phase, input.previous),
    revision,
    criteriaRule: input.previous
      ? `keep the existing ones; add 3-${MAX_NEW_CRITERIA} new ones for this phase`
      : `3-${MAX_NEW_CRITERIA} criteria`,
    schema: JSON.stringify(specSchema, null, 2),
  });
  const messages: ChatMessage[] = [await plannerSystemMessage(ctx), { role: "user", content: prompt }];
  const label = `spec${input.phase && input.phase.plan.length > 1 ? `.phase${input.phase.index + 1}` : ""}${input.revise ? ".revise" : ""}`;
  for (let attempt = 1; ; attempt++) {
    const reply = await ctx.gateway.chat("spec", messages, { json: true, label });
    let errors: string[];
    let spec: unknown;
    try {
      spec = extractJson(reply.content);
      errors = validateSpec(spec);
      if (errors.length === 0) {
        const s = spec as PluginSpec;
        if (input.previous) errors.push(...extensionErrors(input.previous, s));
        const added = s.acceptance.length - (input.previous?.acceptance.length ?? 0);
        if (added > MAX_NEW_CRITERIA) errors.push(`${added} new acceptance criteria; at most ${MAX_NEW_CRITERIA} per phase`);
      }
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
