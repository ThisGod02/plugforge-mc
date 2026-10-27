import { formatCheckResult, type CheckResult } from "@plugforge/bench";
import type { ChatMessage, Route } from "../llm/types.ts";
import { readTree, renderFiles } from "../workspace/files.ts";
import { baseVars, mainClassPath, renderPrompt, renderTests, systemMessage, type StageContext } from "./context.ts";
import { applyEdits, parseEdits } from "./protocol.ts";

const MAX_SOURCE_CHARS = 150_000;

export interface FixOutcome {
  changed: string[];
  /** Edits that could not be applied, after the retry. */
  errors: string[];
  /** TEST_DISPUTE lines: the model believes a test is wrong (TestReview arrives in M3). */
  disputes: string[];
  explanation: string;
}

/** All main sources, or only the ones the failure points at when the project is large. */
async function relevantSources(ctx: StageContext, check: CheckResult): Promise<Map<string, string>> {
  const all = await readTree(ctx.projectDir, "src/main");
  const size = [...all.values()].reduce((n, c) => n + c.length, 0);
  if (size <= MAX_SOURCE_CHARS) return all;
  const text = formatCheckResult(check);
  const keep = new Map<string, string>();
  for (const [rel, content] of all) {
    const base = rel.split("/").pop()!.replace(/\.java$/, "");
    if (rel === mainClassPath(ctx.spec) || rel.endsWith("plugin.yml") || text.includes(rel) || text.includes(base)) keep.set(rel, content);
  }
  return keep;
}

/**
 * Fixer (PLAN.md §6.5): gets the compact check result plus sources and answers with
 * search/replace edits. A reply whose edits do not apply gets one retry with the errors.
 */
export async function fixProject(
  ctx: StageContext,
  opts: { check: CheckResult; route: Extract<Route, "fix" | "fix_escalation">; history: string[]; iteration: number },
): Promise<FixOutcome> {
  const history = opts.history.length
    ? `\n## Earlier attempts (do not repeat what did not work)\n${opts.history.map((h) => `- ${h}`).join("\n")}\n`
    : "";
  const prompt = await renderPrompt("fixer", {
    ...baseVars(ctx),
    check: formatCheckResult(opts.check),
    history,
    tests: await renderTests(ctx.projectDir),
    files: renderFiles(await relevantSources(ctx, opts.check)),
  });
  const messages: ChatMessage[] = [await systemMessage(ctx), { role: "user", content: prompt }];

  const changed = new Set<string>();
  let errors: string[] = [];
  let explanation = "";
  const disputes: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await ctx.gateway.chat(opts.route, messages, { label: `fixer.${opts.iteration}${attempt > 1 ? ".retry" : ""}` });
    const parsed = parseEdits(reply.content);
    const applied = await applyEdits(ctx.projectDir, parsed.edits);
    applied.changed.forEach((c) => changed.add(c));
    errors = [...parsed.errors, ...applied.errors];
    if (parsed.edits.length === 0 && parsed.errors.length === 0) errors.push("no edits found in the answer");

    if (attempt === 1) explanation = reply.content.split(/\r?\n(?:<{5,}|\s*\**FILE:)/)[0]!.trim().slice(0, 600);
    for (const line of reply.content.split(/\r?\n/)) if (line.startsWith("TEST_DISPUTE:")) disputes.push(line.slice(13).trim());

    if (errors.length === 0) break;
    ctx.log(`Fixer: ${errors.length} edit problem(s): ${errors.join("; ")}`);
    if (attempt === 2) break;
    const current = renderFiles(await readTree(ctx.projectDir, "src/main"));
    messages.push(
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content:
          `Some edits could not be applied:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
          `${changed.size ? `Edits to ${[...changed].join(", ")} were applied. ` : ""}` +
          `Here are the files as they are now. Send only the missing edits.\n\n${current}`,
      },
    );
  }
  return { changed: [...changed], errors, disputes, explanation };
}
