import type { Diagnostic, StageResult } from "@plugforge/bench";
import type { ChatMessage } from "../llm/types.ts";
import type { PluginSpec } from "../spec/spec.ts";
import { readTree, renderFiles, testPath } from "../workspace/files.ts";
import { baseVars, plannerSystemMessage, rawPrompt, renderPrompt, type StageContext } from "./context.ts";
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

function formatDiagnostics(ds: Diagnostic[]): string[] {
  return ds
    .filter((d) => d.severity === "error")
    .map((d) => `${d.file ?? ""}${d.line ? `:${d.line}` : ""}: ${d.message}${d.detail ? `\n${d.detail.replace(/^/gm, "    ")}` : ""}`);
}

/**
 * TestWriter (PLAN.md §6.3): MockBukkit tests for every acceptance criterion, written before
 * the code. Accepted only when every criterion has a test and the tests compile against the
 * scaffold; otherwise up to two repair rounds with the concrete problems.
 */
export async function writeTests(ctx: StageContext, compile: CompileTests): Promise<{ files: string[]; byCriterion: Record<string, string[]> }> {
  const template = templateTestPath(ctx.spec);
  const policy = (raw: string) => {
    const rel = testPath(raw);
    if (rel === template) throw new Error(`${rel} belongs to the template; put acceptance tests in another file`);
    return rel;
  };
  const vars = {
    ...baseVars(ctx),
    packageDir: ctx.spec.package.replaceAll(".", "/"),
    templateTest: template,
    mockbukkit: await rawPrompt("mockbukkit"),
    feedback: "",
  };
  const messages: ChatMessage[] = [await plannerSystemMessage(ctx), { role: "user", content: await renderPrompt("test-writer", vars) }];

  for (let round = 1; ; round++) {
    const reply = await ctx.gateway.chat("tests", messages, { label: round === 1 ? "tests" : `tests.repair${round - 1}` });
    const parsed = parseEdits(reply.content);
    const applied = await applyEdits(ctx.projectDir, parsed.edits, policy);
    const problems = [...parsed.errors, ...applied.errors];
    if (parsed.edits.length === 0 && parsed.errors.length === 0) problems.push("no FILE: or SEARCH blocks found in the answer");

    const tests = await readTree(ctx.projectDir, "src/test");
    tests.delete(template);
    const coverage = testCoverage(ctx.spec, tests);
    for (const id of coverage.missing) problems.push(`${id} has no @Test method whose name starts with '${id.toLowerCase()}'`);

    if (problems.length === 0) {
      ctx.log(`TestWriter: compiling ${tests.size} test file(s)`);
      const compiled = await compile(ctx.projectDir);
      if (!compiled.ok) problems.push(...formatDiagnostics(compiled.diagnostics));
    }
    if (problems.length === 0) {
      const count = Object.values(coverage.byCriterion).reduce((n, m) => n + m.length, 0);
      ctx.log(`TestWriter: ${count} tests cover ${ctx.spec.acceptance.length} criteria`);
      return { files: [...tests.keys()], byCriterion: coverage.byCriterion };
    }

    ctx.log(`TestWriter: ${problems.length} problem(s): ${problems[0]!.split("\n")[0]}`);
    if (round >= ROUNDS) throw new Error(`TestWriter could not produce compiling tests for every criterion:\n  ${problems.join("\n  ")}`);
    messages.push(
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content:
          `The tests are not accepted yet:\n${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
          `Remember: the plugin code does not exist yet; only ${ctx.spec.package}.${ctx.spec.mainClass} and its JavaPlugin methods can be referenced.\n\n` +
          `Current test files:\n\n${renderFiles(tests)}\n\nFix them with SEARCH/REPLACE or FILE: blocks (test files only).`,
      },
    );
  }
}
