import type { Diagnostic, StageResult } from "@plugforge/bench";
import type { ChatMessage } from "../llm/types.ts";
import type { PluginSpec } from "../spec/spec.ts";
import { readTree, renderFiles, testPath } from "../workspace/files.ts";
import { baseVars, extending, plannerSystemMessage, rawPrompt, renderCriteria, renderPrompt, type StageContext } from "./context.ts";
import { applyEdits, parseEdits } from "./protocol.ts";

const ROUNDS = 3;

export type CompileTests = (projectDir: string) => Promise<StageResult>;

const TEST_METHOD = /@Test\b[^;{]*?\bvoid\s+(\w+)\s*\(/g;

/** Test methods per acceptance criterion (by name prefix `ac<N>`) and the criteria without any. */
export function testCoverage(spec: PluginSpec, tests: Map<string, string>): { byCriterion: Record<string, string[]>; missing: string[] } {
  const methods = [...tests.values()].flatMap((src) => [...src.matchAll(TEST_METHOD)].map((m) => m[1]!));
  const byCriterion: Record<string, string[]> = {};
  for (const ac of spec.acceptance) {
    const prefix = ac.id.toLowerCase();
    byCriterion[ac.id] = methods.filter((m) => m.toLowerCase().startsWith(prefix) && !/\d/.test(m.charAt(prefix.length)));
  }
  return { byCriterion, missing: spec.acceptance.filter((ac) => byCriterion[ac.id]!.length === 0).map((ac) => ac.id) };
}

export const templateTestPath = (spec: PluginSpec) => `src/test/java/${spec.package.replaceAll(".", "/")}/${spec.mainClass}Test.java`;

/** Test file a phase writes into; earlier phases keep theirs untouched. */
export const phaseTestFile = (ctx: StageContext) => `${ctx.spec.mainClass}${extending(ctx) ? `Phase${ctx.phase!.index + 1}` : "Acceptance"}Test.java`;

function formatDiagnostics(ds: Diagnostic[]): string[] {
  return ds
    .filter((d) => d.severity === "error")
    .map((d) => `${d.file ?? ""}${d.line ? `:${d.line}` : ""}: ${d.message}${d.detail ? `\n${d.detail.replace(/^/gm, "    ")}` : ""}`);
}

/**
 * TestWriter (PLAN.md §6.3): MockBukkit tests for every new acceptance criterion, written before
 * the code that implements it. Accepted only when every criterion in scope has a test and the
 * tests compile against the current project; otherwise up to two repair rounds. In later phases
 * the tests of earlier phases are shown but fixed: they stay as regression.
 */
export async function writeTests(ctx: StageContext, compile: CompileTests): Promise<{ files: string[]; byCriterion: Record<string, string[]> }> {
  const template = templateTestPath(ctx.spec);
  const testFile = phaseTestFile(ctx);
  const before = await readTree(ctx.projectDir, "src/test");
  const policy = (raw: string) => {
    const rel = testPath(raw);
    if (!rel.endsWith(".java")) throw new Error(`${rel}: TestWriter writes Java tests only`);
    if (rel === template) throw new Error(`${rel} belongs to the template; put acceptance tests in ${testFile}`);
    if (before.has(rel)) throw new Error(`${rel} is a test of an earlier phase and is fixed; put new tests in ${testFile}`);
    return rel;
  };
  const target: PluginSpec = { ...ctx.spec, acceptance: ctx.phase?.newCriteria ?? ctx.spec.acceptance };
  const earlier = new Map([...before].filter(([rel]) => rel !== template && rel.endsWith(".java")));
  const vars = {
    ...baseVars(ctx),
    packageDir: ctx.spec.package.replaceAll(".", "/"),
    testFile,
    scope: extending(ctx)
      ? `\n## Scope: phase ${ctx.phase!.index + 1} of ${ctx.phase!.total} — ${ctx.phase!.title}\n` +
        "The plugin already passes the tests of earlier phases (below); they stay as regression and must not be changed or repeated. " +
        `Write tests only for the new criteria:\n${renderCriteria(ctx)}\n\n### Existing tests (fixed)\n${renderFiles(earlier)}\n`
      : "",
    codeState: extending(ctx) ? "Code from earlier phases exists, but the new behaviour does not yet." : "The plugin code does not exist yet.",
    mockbukkit: await rawPrompt("mockbukkit"),
    feedback: "",
  };
  const messages: ChatMessage[] = [await plannerSystemMessage(ctx), { role: "user", content: await renderPrompt("test-writer", vars) }];
  const label = `tests${extending(ctx) ? `.phase${ctx.phase!.index + 1}` : ""}`;

  for (let round = 1; ; round++) {
    const reply = await ctx.gateway.chat("tests", messages, { label: round === 1 ? label : `${label}.repair${round - 1}` });
    const parsed = parseEdits(reply.content);
    const applied = await applyEdits(ctx.projectDir, parsed.edits, policy);
    const problems = [...parsed.errors, ...applied.errors];
    if (parsed.edits.length === 0 && parsed.errors.length === 0) problems.push("no FILE: or SEARCH blocks found in the answer");

    const tests = await readTree(ctx.projectDir, "src/test");
    tests.delete(template);
    const fresh = new Map([...tests].filter(([rel]) => !before.has(rel) && rel.endsWith(".java")));
    const coverage = testCoverage(target, fresh);
    for (const id of coverage.missing) problems.push(`${id} has no @Test method whose name starts with '${id.toLowerCase()}'`);

    if (problems.length === 0) {
      ctx.log(`TestWriter: compiling ${tests.size} test file(s)`);
      const compiled = await compile(ctx.projectDir);
      if (!compiled.ok) problems.push(...formatDiagnostics(compiled.diagnostics));
    }
    if (problems.length === 0) {
      const count = Object.values(coverage.byCriterion).reduce((n, m) => n + m.length, 0);
      ctx.log(`TestWriter: ${count} tests cover ${target.acceptance.length} criteria`);
      return { files: [...fresh.keys()], byCriterion: coverage.byCriterion };
    }

    ctx.log(`TestWriter: ${problems.length} problem(s): ${problems[0]!.split("\n")[0]}`);
    if (round >= ROUNDS) throw new Error(`TestWriter could not produce compiling tests for every criterion:\n  ${problems.join("\n  ")}`);
    messages.push(
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content:
          `The tests are not accepted yet:\n${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
          `Remember: only ${ctx.spec.package}.${ctx.spec.mainClass} and its JavaPlugin methods can be referenced.\n\n` +
          `Your test files as they are now:\n\n${fresh.size ? renderFiles(fresh) : "(none)"}\n\nFix them with SEARCH/REPLACE or FILE: blocks (only ${testFile}).`,
      },
    );
  }
}
