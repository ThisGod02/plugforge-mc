import { cp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadScenarios, type CheckResult, type Diagnostic } from "@plugforge/bench";
import type { Log } from "@plugforge/runtime";
import { BudgetExceededError, type LlmGateway } from "../llm/gateway.ts";
import type { PluginSpec } from "../spec/spec.ts";
import { writeProject } from "../stages/coder.ts";
import type { StageContext } from "../stages/context.ts";
import { fixProject } from "../stages/fixer.ts";
import { reviewCoverage, specGaps, specLanguage } from "../stages/reporter.ts";
import { writeScenarios } from "../stages/scenariowriter.ts";
import { reviewTests } from "../stages/testreview.ts";
import { templateTestPath, testCoverage, writeTests, type CompileTests } from "../stages/testwriter.ts";
import { scaffoldPlugin } from "../workspace/scaffold.ts";
import { listFiles, lockedFingerprint, readTree } from "../workspace/files.ts";
import { specConformance } from "./conformance.ts";
import { deliver, type Delivery } from "./deliver.ts";
import type { RunLog } from "./runlog.ts";

export type AgentState =
  | "SCAFFOLD"
  | "TESTS_WRITE"
  | "SCENARIOS_WRITE"
  | "CODE_WRITE"
  | "CHECK"
  | "FIX"
  | "TEST_REVIEW"
  | "REPORT"
  | "DONE"
  | "STUCK"
  | "ERROR";

export interface AgentOptions {
  spec: PluginSpec;
  /** Overlay with ready-made tests, laid out like the project (`src/test/java/...`). Without it TestWriter writes them. */
  testsDir?: string;
  /** Compiles tests without running them; required when TestWriter writes the tests. */
  compileTests?: CompileTests;
  /** Request, questions and answers that produced the spec; stored in run.json. */
  intake?: Record<string, unknown>;
  /** Fixer TEST_DISPUTEs sent to TestReview per run (default 2). */
  maxTestReviews?: number;
  /** Write live scenarios (L2) next to the tests TestWriter writes; `check` is expected to play them. */
  liveScenarios?: boolean;
  /** Must not exist or be empty. */
  projectDir: string;
  gateway: LlmGateway;
  /** L0 + validation + L1 on the project (the bench's checkProject). */
  check: (projectDir: string) => Promise<CheckResult>;
  runLog: RunLog;
  log: Log;
  paperApi: string;
  pluginApiVersion: string;
  /** Minecraft/Paper version the plugin was tested on, for the README. */
  minecraftVersion: string;
  /** PLAN.md §3: max_fix_iterations, 8 by default. */
  maxFixIterations?: number;
  /** Same failure this many times in a row → use the fix_escalation route. */
  escalateAfter?: number;
  /** Same failure this many times in a row → STUCK. */
  stuckAfter?: number;
}

export interface AgentResult {
  status: "done" | "stuck" | "error";
  reason?: string;
  /** Number of Fixer rounds. */
  fixIterations: number;
  check?: CheckResult;
  disputes: string[];
  /** Test methods per acceptance criterion. */
  coverage?: Record<string, string[]>;
  /** The installable jar and README, only when status is "done". */
  delivery?: Delivery;
}

function errorsOf(r: CheckResult): Diagnostic[] {
  return [...r.build.diagnostics, ...(r.validate?.diagnostics ?? []), ...(r.test?.diagnostics ?? [])].filter((d) => d.severity === "error");
}

/** Identity of a failure, to notice when fixes stop making progress. */
export function failureSignature(r: CheckResult): string {
  const parts = errorsOf(r).map((d) => `${d.file ?? ""}:${d.line ?? ""}:${d.message}`);
  for (const c of r.test?.cases ?? []) if (c.status === "failed" || c.status === "error") parts.push(`${c.suite}.${c.name}:${c.message ?? ""}`);
  for (const s of r.live?.scenarios ?? []) {
    // Step and the first part of the reason: timings and chat tails vary between runs.
    if (s.status === "failed") parts.push(`${s.id}:${s.steps.find((x) => !x.ok)?.at ?? ""}:${(s.failure ?? "").slice(0, 120)}`);
  }
  return `${r.failedStage}|${parts.sort().join("|")}`;
}

/** One line for the Fixer's "earlier attempts" list. */
function failureSummary(r: CheckResult): string {
  const failedScenarios = (r.live?.scenarios ?? []).filter((s) => s.status === "failed");
  if (r.failedStage === "live" && failedScenarios.length) {
    return `${failedScenarios.length} live scenario(s) failed, e.g. ${failedScenarios[0]!.id}: ${(failedScenarios[0]!.failure ?? "").slice(0, 200)}`;
  }
  const failedTests = (r.test?.cases ?? []).filter((c) => c.status === "failed" || c.status === "error");
  if (failedTests.length) return `${failedTests.length} test(s) failed, e.g. ${failedTests[0]!.name}: ${(failedTests[0]!.message ?? "").slice(0, 160)}`;
  const errs = errorsOf(r);
  const first = errs[0];
  return `${r.failedStage} failed with ${errs.length} error(s), e.g. ${first?.file ?? ""}${first?.line ? `:${first.line}` : ""} ${first?.message ?? ""}`.trim();
}

/** Adds live scenarios to the per-criterion coverage, as "scenario <id>". */
async function withScenarios(coverage: Record<string, string[]> | undefined, projectDir: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(coverage ?? {}).map(([k, v]) => [k, [...v]]));
  for (const sc of (await loadScenarios(projectDir)).scenarios) {
    for (const id of sc.covers) if (out[id]) out[id].push(`scenario ${sc.id}`);
  }
  return out;
}

async function installTests(testsDir: string, projectDir: string): Promise<number> {
  const files = await listFiles(testsDir, ".");
  const outside = files.filter((f) => !f.replace(/^\.\//, "").startsWith("src/test/"));
  if (outside.length) throw new Error(`tests overlay may only contain src/test/**, found ${outside.join(", ")}`);
  await cp(testsDir, projectDir, { recursive: true, force: true });
  return files.length;
}

function sameFingerprint(a: Map<string, string>, b: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) changed.push(k);
  for (const k of b.keys()) if (!a.has(k)) changed.push(k);
  return changed;
}

/**
 * Orchestrator (PLAN.md §3): a fixed state machine around the LLM stages.
 * SCAFFOLD → TESTS_WRITE → CODE_WRITE → CHECK ─fail→ FIX (→ TEST_REVIEW) → CHECK … → DONE,
 * or STUCK on limits. Clarifier and SpecWriter run before this, in the caller, because they
 * need the user.
 */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const maxFix = o.maxFixIterations ?? 8;
  const escalateAfter = o.escalateAfter ?? 3;
  const stuckAfter = o.stuckAfter ?? 5;
  const maxReviews = o.maxTestReviews ?? 2;
  const { spec, projectDir, runLog, log } = o;
  const ctx: StageContext = { spec, projectDir, gateway: o.gateway, paperApi: o.paperApi, pluginApiVersion: o.pluginApiVersion, log };
  const disputes: string[] = [];
  let fixIterations = 0;
  let reviews = 0;
  let last: CheckResult | undefined;
  let coverage: Record<string, string[]> | undefined;

  const enter = async (state: AgentState, data: Record<string, unknown> = {}) => {
    await runLog.event(state, data);
    log(`[${state}]${data.note ? ` ${String(data.note)}` : ""}`);
  };
  const finish = async (partial: AgentResult): Promise<AgentResult> => {
    const result = { ...partial, coverage };
    await enter(result.status === "done" ? "DONE" : result.status === "stuck" ? "STUCK" : "ERROR", { note: result.reason ?? "" });
    await runLog.write({
      status: result.status,
      reason: result.reason,
      fixIterations: result.fixIterations,
      testReviews: reviews,
      delivery: result.delivery,
      disputes: result.disputes,
      coverage,
      intake: o.intake,
      spec,
      projectDir,
      routing: o.gateway.config.routing,
      models: Object.fromEntries(Object.entries(o.gateway.config.profiles).map(([k, p]) => [k, p.model])),
      totals: o.gateway.totals,
      finishedAt: new Date().toISOString(),
    });
    return result;
  };

  try {
    await enter("SCAFFOLD", { note: projectDir });
    await scaffoldPlugin(projectDir, { name: spec.name, packageName: spec.package, mainClass: spec.mainClass, description: spec.description });
    // The approved spec travels with the project (for the user, and for change requests in M9).
    await writeFile(path.join(projectDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);

    if (o.testsDir) {
      log(`installed ${await installTests(o.testsDir, projectDir)} ready-made test file(s)`);
      const tests = await readTree(projectDir, "src/test");
      tests.delete(templateTestPath(spec));
      coverage = await withScenarios(testCoverage(spec, tests).byCriterion, projectDir);
      const missing = Object.entries(coverage).filter(([, t]) => t.length === 0).map(([id]) => id);
      if (missing.length) log(`warning: no tests or scenarios for ${missing.join(", ")}`);
    } else {
      if (!o.compileTests) throw new Error("compileTests is required when the agent writes the tests");
      await enter("TESTS_WRITE");
      coverage = (await writeTests(ctx, o.compileTests)).byCriterion;
      if (o.liveScenarios) {
        await enter("SCENARIOS_WRITE");
        try {
          await writeScenarios(ctx);
        } catch (err) {
          if (err instanceof BudgetExceededError) throw err;
          // Live tests add confidence; without usable scenarios the run still has L0+L1.
          log(`warning: ${(err as Error).message.split("\n")[0]}; continuing without live tests`);
          await runLog.event("SCENARIOS_SKIPPED", { reason: (err as Error).message });
        }
        coverage = await withScenarios(coverage, projectDir);
      }
    }
    await runLog.event("TESTS_LOCKED", { coverage });
    let locked = await lockedFingerprint(projectDir);

    await enter("CODE_WRITE");
    await writeProject(ctx);

    const history: string[] = [];
    let lastSignature = "";
    let repeats = 0;
    for (;;) {
      await runLog.snapshot(fixIterations, projectDir);
      await enter("CHECK", { iteration: fixIterations });
      let result = await o.check(projectDir);
      if (result.ok) {
        const conformance = await specConformance(projectDir, spec);
        if (conformance.length) result = { ...result, ok: false, failedStage: "validate", validate: { ok: false, durationMs: 0, diagnostics: conformance } };
      }
      last = result;
      await runLog.check(fixIterations, result);

      const tampered = sameFingerprint(locked, await lockedFingerprint(projectDir));
      if (tampered.length) return await finish({ status: "error", reason: `locked files changed: ${tampered.join(", ")}`, fixIterations, check: result, disputes });

      if (result.ok) {
        const t = result.test;
        const l = result.live;
        const green = `L0+L1${l ? "+L2" : ""} green, ${t?.passed}/${t?.total} tests${l ? `, ${l.passed}/${l.total} live scenarios` : ""}`;
        await enter("REPORT");
        const untested = specGaps(spec, specLanguage(spec));
        try {
          untested.push(...(await reviewCoverage(ctx)));
        } catch (err) {
          // A failed audit must not cost the user a working plugin; the spec gaps still go in.
          if (err instanceof BudgetExceededError) throw err;
          log(`Reporter: coverage review failed (${(err as Error).message}); listing spec gaps only`);
        }
        log(`Reporter: ${untested.length} thing(s) not covered by tests`);
        const delivery = await deliver(projectDir, spec, result, { paperVersion: o.minecraftVersion, coverage, untested });
        return await finish({ status: "done", reason: green, fixIterations, check: result, disputes, delivery });
      }
      log(`check failed: ${failureSummary(result)}`);
      if (fixIterations >= maxFix) return await finish({ status: "stuck", reason: `fix limit of ${maxFix} iterations reached`, fixIterations, check: result, disputes });

      const signature = failureSignature(result);
      repeats = signature === lastSignature ? repeats + 1 : 1;
      lastSignature = signature;
      if (repeats >= stuckAfter) return await finish({ status: "stuck", reason: `same failure ${repeats} times in a row`, fixIterations, check: result, disputes });
      const route = repeats >= escalateAfter ? "fix_escalation" : "fix";

      fixIterations++;
      await enter("FIX", { iteration: fixIterations, route, note: `#${fixIterations} via ${o.gateway.profileFor(route)}${repeats > 1 ? ` (same failure x${repeats})` : ""}` });
      const fix = await fixProject(ctx, { check: result, route, history: history.slice(-5), iteration: fixIterations });
      disputes.push(...fix.disputes);
      log(`Fixer changed ${fix.changed.length ? fix.changed.join(", ") : "nothing"}${fix.explanation ? ` — ${fix.explanation.split("\n")[0]}` : ""}`);
      history.push(
        `#${fixIterations}: ${failureSummary(result)} → changed ${fix.changed.join(", ") || "nothing"}` +
          (fix.errors.length ? ` (unapplied: ${fix.errors.join("; ")})` : ""),
      );

      if (fix.disputes.length && reviews < maxReviews) {
        reviews++;
        await enter("TEST_REVIEW", { note: fix.disputes.join(" | ").slice(0, 200) });
        const review = await reviewTests(ctx, { dispute: fix.disputes.join("\n"), check: result });
        await runLog.event("TEST_REVIEW_VERDICT", { verdict: review.verdict, reason: review.reason, changed: review.changed });
        log(`TestReview: ${review.verdict.toUpperCase()} — ${review.reason.split("\n")[0]}`);
        if (review.changed.length) {
          locked = await lockedFingerprint(projectDir);
          history.push(`TestReview changed ${review.changed.join(", ")}: ${review.reason.split("\n")[0]}`);
        } else {
          history.push(`TestReview kept the tests: ${review.reason.split("\n")[0]}. Fix the code instead.`);
        }
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) return finish({ status: "stuck", reason: err.message, fixIterations, check: last, disputes });
    return finish({ status: "error", reason: (err as Error).message, fixIterations, check: last, disputes });
  }
}

/** True when the directory is missing or empty (the agent never writes into existing work). */
export async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(path.resolve(dir))).length === 0;
  } catch {
    return true;
  }
}
