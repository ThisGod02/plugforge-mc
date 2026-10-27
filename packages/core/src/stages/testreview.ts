import { rm } from "node:fs/promises";
import path from "node:path";
import { formatCheckResult, type CheckResult } from "@plugforge/bench";
import { readTree, renderFiles, testPath, writeProjectFile } from "../workspace/files.ts";
import { plannerSystemMessage, rawPrompt, renderPrompt, baseVars, type StageContext } from "./context.ts";
import { applyEdits, parseEdits } from "./protocol.ts";
import { testCoverage } from "./testwriter.ts";

export interface ReviewOutcome {
  verdict: "keep" | "change";
  reason: string;
  changed: string[];
}

/**
 * TestReview (PLAN.md §6.3): a separate call decides a Fixer's TEST_DISPUTE. Only this stage
 * may change tests after they are locked; a change that loses criterion coverage is rolled back.
 */
export async function reviewTests(ctx: StageContext, input: { dispute: string; check: CheckResult }): Promise<ReviewOutcome> {
  const before = await readTree(ctx.projectDir, "src/test");
  const prompt = await renderPrompt("test-review", {
    ...baseVars(ctx),
    dispute: input.dispute,
    check: formatCheckResult(input.check),
    tests: renderFiles(before),
    files: renderFiles(await readTree(ctx.projectDir, "src/main")),
    mockbukkit: await rawPrompt("mockbukkit"),
  });
  const reply = await ctx.gateway.chat("test_review", [await plannerSystemMessage(ctx), { role: "user", content: prompt }], { label: "test_review" });
  const verdict = /VERDICT:\s*CHANGE/i.test(reply.content) ? "change" : "keep";
  const reason = reply.content.replace(/^[\s\S]*?VERDICT:\s*\w+\s*/i, "").split(/\r?\n(?:<{5,}|\s*\**FILE:)/)[0]!.trim().slice(0, 400);
  if (verdict === "keep") return { verdict, reason, changed: [] };

  const applied = await applyEdits(ctx.projectDir, parseEdits(reply.content).edits, testPath);
  const after = await readTree(ctx.projectDir, "src/test");
  const missing = testCoverage(ctx.spec, after).missing;
  if (missing.length || applied.changed.length === 0) {
    // Restore the locked tests exactly; a review must not drop coverage.
    for (const rel of after.keys()) if (!before.has(rel)) await rm(path.join(ctx.projectDir, rel), { force: true });
    for (const [rel, content] of before) await writeProjectFile(ctx.projectDir, rel, content);
    const why = missing.length ? `it would leave ${missing.join(", ")} without tests` : `its edits did not apply (${applied.errors.join("; ")})`;
    return { verdict: "keep", reason: `change rejected: ${why}`, changed: [] };
  }
  return { verdict, reason, changed: applied.changed };
}
