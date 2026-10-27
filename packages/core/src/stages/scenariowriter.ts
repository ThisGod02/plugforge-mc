import { rm } from "node:fs/promises";
import path from "node:path";
import { SCENARIO_DIR, loadScenarios } from "@plugforge/bench";
import type { ChatMessage } from "../llm/types.ts";
import { readTree, renderFiles, scenarioPath } from "../workspace/files.ts";
import { baseVars, extending, plannerSystemMessage, rawPrompt, renderCriteria, renderPrompt, renderTests, type StageContext } from "./context.ts";
import { applyEdits, parseEdits } from "./protocol.ts";

const ROUNDS = 3;
const MAX_SCENARIOS = 6;

/**
 * ScenarioWriter (PLAN.md §6.3, L2 part): live scenarios written before the code, from the spec
 * alone, for what MockBukkit cannot prove. Accepted when every file parses and validates against
 * the DSL and the spec's acceptance ids; otherwise up to two repair rounds.
 */
export async function writeScenarios(ctx: StageContext): Promise<string[]> {
  const criteria = ctx.spec.acceptance.map((a) => a.id);
  const earlier = await readTree(ctx.projectDir, SCENARIO_DIR);
  const policy = (raw: string) => {
    const rel = scenarioPath(raw);
    if (earlier.has(rel)) throw new Error(`${rel} is a scenario of an earlier phase and is fixed; write a new file`);
    return rel;
  };
  const vars = {
    ...baseVars(ctx),
    tests: await renderTests(ctx.projectDir),
    scope: extending(ctx)
      ? `\n## Scope: phase ${ctx.phase!.index + 1} of ${ctx.phase!.total} — ${ctx.phase!.title}\n` +
        "The scenarios of earlier phases (below) are replayed as regression; do not change or repeat them. " +
        `Write new scenarios for what this phase adds:\n${renderCriteria(ctx)}\n\n### Existing scenarios (fixed)\n${earlier.size ? renderFiles(earlier) : "(none)"}\n`
      : "",
    dsl: await rawPrompt("live-dsl"),
    max: String(MAX_SCENARIOS),
    feedback: "",
  };
  const messages: ChatMessage[] = [await plannerSystemMessage(ctx), { role: "user", content: await renderPrompt("scenario-writer", vars) }];

  for (let round = 1; ; round++) {
    const label = `scenarios${extending(ctx) ? `.phase${ctx.phase!.index + 1}` : ""}`;
    const reply = await ctx.gateway.chat("scenarios", messages, { label: round === 1 ? label : `${label}.repair${round - 1}` });
    const parsed = parseEdits(reply.content);
    const applied = await applyEdits(ctx.projectDir, parsed.edits, policy);
    const problems = [...parsed.errors, ...applied.errors];
    if (parsed.edits.length === 0 && parsed.errors.length === 0) problems.push("no FILE: blocks found in the answer");

    const all = await loadScenarios(ctx.projectDir, criteria);
    const scenarios = all.scenarios.filter((s) => !earlier.has(s.file));
    const errors = new Map([...all.errors].filter(([file]) => !earlier.has(file)));
    for (const [file, errs] of errors) for (const e of errs) problems.push(`${file}: ${e}`);
    if (scenarios.length + errors.size > MAX_SCENARIOS) problems.push(`write at most ${MAX_SCENARIOS} scenarios`);
    if (scenarios.length + errors.size === 0) problems.push("write at least one scenario");

    if (problems.length === 0) {
      ctx.log(`ScenarioWriter: ${scenarios.length} live scenario(s): ${scenarios.map((s) => `${s.id} [${s.covers.join(",")}]`).join(", ")}`);
      return scenarios.map((s) => s.file);
    }
    ctx.log(`ScenarioWriter: ${problems.length} problem(s): ${problems[0]}`);
    if (round >= ROUNDS) {
      // Unusable scenarios must not reach the live stage; this phase continues with L1 only.
      for (const rel of (await readTree(ctx.projectDir, SCENARIO_DIR)).keys()) {
        if (!earlier.has(rel)) await rm(path.join(ctx.projectDir, rel), { force: true });
      }
      throw new Error(`ScenarioWriter could not produce valid scenarios:\n  ${problems.join("\n  ")}`);
    }
    const current = new Map([...(await readTree(ctx.projectDir, SCENARIO_DIR))].filter(([rel]) => !earlier.has(rel)));
    messages.push(
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content:
          `The scenarios are not accepted yet:\n${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
          `Current scenario files:\n\n${current.size ? renderFiles(current) : "(none)"}\n\n` +
          "Fix them with FILE: blocks (whole files). To drop a broken scenario, rewrite it as a valid one.",
      },
    );
  }
}
