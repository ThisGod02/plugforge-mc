import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadScenarios, type CheckResult, type Diagnostic } from "@plugforge/bench";
import type { Log } from "@plugforge/runtime";
import { BudgetExceededError, type LlmGateway } from "../llm/gateway.ts";
import type { PluginSpec } from "../spec/spec.ts";
import { writeProject } from "../stages/coder.ts";
import type { StageContext } from "../stages/context.ts";
import { fixProject } from "../stages/fixer.ts";
import type { PhasePlanItem } from "../stages/phaseplanner.ts";
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
  | "PHASE"
  | "TESTS_WRITE"
  | "SCENARIOS_WRITE"
  | "CODE_WRITE"
  | "CHECK"
  | "FIX"
  | "TEST_REVIEW"
  | "ROLLBACK"
  | "REPORT"
  | "DONE"
  | "PARTIAL"
  | "STUCK"
  | "ERROR";

export interface AgentOptions {
  /** Spec of the first (or only) phase. */
  spec: PluginSpec;
  /** Build phases (PLAN.md: big requests are built in steps). Default: one phase. */
  phases?: PhasePlanItem[];
  /** Cumulative spec for phase `index` (>= 1) on top of the previous phase's; may ask the user. */
  nextSpec?: (index: number, previous: PluginSpec) => Promise<PluginSpec>;
  /** Overlay with ready-made tests, laid out like the project (`src/test/java/...`). Single-phase only. */
  testsDir?: string;
  /** Compiles tests without running them; required when TestWriter writes the tests. */
  compileTests?: CompileTests;
  /** Request, questions and answers that produced the spec; stored in run.json. */
  intake?: Record<string, unknown>;
  /** Fixer TEST_DISPUTEs sent to TestReview per phase (default 2). */
  maxTestReviews?: number;
  /** Write live scenarios (L2) next to the tests TestWriter writes; `check` is expected to play them. */
  liveScenarios?: boolean;
  /** Must not exist or be empty. */
  projectDir: string;
  gateway: LlmGateway;
  /** L0 + validation + L1 (+ L2) on the project. */
  check: (projectDir: string) => Promise<CheckResult>;
  runLog: RunLog;
  log: Log;
  paperApi: string;
  pluginApiVersion: string;
  /** Minecraft/Paper version the plugin was tested on, for the README. */
  minecraftVersion: string;
  /** Fixer rounds per phase (default 10). */
  maxFixIterations?: number;
  /** Same failure this many times in a row → use the fix_escalation route. */
  escalateAfter?: number;
  /** Same failure this many times in a row → STUCK. */
  stuckAfter?: number;
}

export interface PhaseOutcome {
  title: string;
  status: "done" | "failed" | "not_started";
  reason?: string;
  fixIterations: number;
  /** Acceptance ids this phase added. */
  criteria: string[];
}

export interface AgentResult {
  /** "partial": some phases are done and delivered, a later one failed and was rolled back. */
  status: "done" | "partial" | "stuck" | "error";
  reason?: string;
  /** Fixer rounds over all phases. */
  fixIterations: number;
  check?: CheckResult;
  disputes: string[];
  /** Test methods and scenarios per acceptance criterion of the delivered spec. */
  coverage?: Record<string, string[]>;
  phases: PhaseOutcome[];
  /** The spec of what was delivered (the last green phase). */
  spec?: PluginSpec;
  /** The installable jar and README, when something green was delivered. */
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

/** Unit tests and live scenarios per acceptance criterion. */
async function coverageOf(spec: PluginSpec, projectDir: string): Promise<Record<string, string[]>> {
  const tests = await readTree(projectDir, "src/test");
  tests.delete(templateTestPath(spec));
  const out = testCoverage(spec, new Map([...tests].filter(([rel]) => rel.endsWith(".java")))).byCriterion;
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

const greenFolder = (projectDir: string) => path.join(projectDir, ".plugforge", "last-green");

/** Keeps sources, tests, scenarios and spec of the last green phase. */
async function saveGreen(projectDir: string): Promise<void> {
  const dir = greenFolder(projectDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(path.join(projectDir, "src"), path.join(dir, "src"), { recursive: true });
  await cp(path.join(projectDir, "spec.json"), path.join(dir, "spec.json"));
}

async function restoreGreen(projectDir: string): Promise<void> {
  const dir = greenFolder(projectDir);
  await rm(path.join(projectDir, "src"), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  await cp(path.join(dir, "src"), path.join(projectDir, "src"), { recursive: true });
  await cp(path.join(dir, "spec.json"), path.join(projectDir, "spec.json"));
}

type PhaseResult = { ok: true; check: CheckResult } | { ok: false; status: "stuck" | "error"; reason: string; check?: CheckResult };

/**
 * Orchestrator (PLAN.md §3): a fixed state machine around the LLM stages, run once per build
 * phase on top of the previous phase's green code:
 *   SCAFFOLD → [PHASE → TESTS_WRITE → SCENARIOS_WRITE → CODE_WRITE → CHECK ─fail→ FIX (→ TEST_REVIEW) → CHECK …]*
 *   → REPORT → DONE, or PARTIAL (rolled back to the last green phase) / STUCK / ERROR.
 * Clarifier, phase planning and SpecWriter run in the caller, because they need the user.
 */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const maxFix = o.maxFixIterations ?? 10;
  const escalateAfter = o.escalateAfter ?? 3;
  const stuckAfter = o.stuckAfter ?? 5;
  const maxReviews = o.maxTestReviews ?? 2;
  const { projectDir, runLog, log } = o;
  const plan = o.phases?.length ? o.phases : [{ title: o.spec.name, goal: o.spec.description }];
  const multi = plan.length > 1;
  if (multi && !o.nextSpec) throw new Error("nextSpec is required for a phased build");
  if (multi && o.testsDir) throw new Error("ready-made tests are only supported for a single-phase build");
  const outcomes: PhaseOutcome[] = plan.map((p) => ({ title: p.title, status: "not_started", fixIterations: 0, criteria: [] }));
  const disputes: string[] = [];
  let fixIterations = 0;
  let spec = o.spec;
  let green: { spec: PluginSpec; check: CheckResult } | undefined;

  const enter = async (state: AgentState, data: Record<string, unknown> = {}) => {
    await runLog.event(state, data);
    log(`[${state}]${data.note ? ` ${String(data.note)}` : ""}`);
  };
  const finish = async (result: AgentResult): Promise<AgentResult> => {
    const final = { DONE: "done", PARTIAL: "partial", STUCK: "stuck", ERROR: "error" } as const;
    const state = (Object.keys(final) as (keyof typeof final)[]).find((k) => final[k] === result.status)!;
    await enter(state, { note: result.reason ?? "" });
    await runLog.write({
      status: result.status,
      reason: result.reason,
      fixIterations: result.fixIterations,
      phases: result.phases,
      delivery: result.delivery,
      disputes: result.disputes,
      coverage: result.coverage,
      intake: { ...o.intake, phases: plan },
      spec: result.spec ?? spec,
      projectDir,
      routing: o.gateway.config.routing,
      models: Object.fromEntries(Object.entries(o.gateway.config.profiles).map(([k, p]) => [k, p.model])),
      totals: o.gateway.totals,
      finishedAt: new Date().toISOString(),
    });
    return result;
  };

  /** One phase: tests and scenarios for its new criteria, code, then check/fix until green. */
  const buildPhase = async (ctx: StageContext, outcome: PhaseOutcome, first: boolean): Promise<PhaseResult> => {
    let reviews = 0;
    if (o.testsDir) {
      log(`installed ${await installTests(o.testsDir, projectDir)} ready-made test file(s)`);
      const missing = Object.entries(await coverageOf(ctx.spec, projectDir)).filter(([, t]) => t.length === 0).map(([id]) => id);
      if (missing.length) log(`warning: no tests or scenarios for ${missing.join(", ")}`);
    } else {
      if (!o.compileTests) throw new Error("compileTests is required when the agent writes the tests");
      await enter("TESTS_WRITE");
      await writeTests(ctx, o.compileTests);
      if (o.liveScenarios) {
        await enter("SCENARIOS_WRITE");
        try {
          await writeScenarios(ctx);
        } catch (err) {
          if (err instanceof BudgetExceededError) throw err;
          // Live tests add confidence; without usable scenarios the phase still has L0+L1.
          log(`warning: ${(err as Error).message.split("\n")[0]}; continuing without new live tests`);
          await runLog.event("SCENARIOS_SKIPPED", { reason: (err as Error).message });
        }
      }
    }
    await runLog.event("TESTS_LOCKED", { coverage: await coverageOf(ctx.spec, projectDir) });
    let locked = await lockedFingerprint(projectDir);

    await enter("CODE_WRITE", { note: first ? "" : "extending the current code" });
    await writeProject(ctx);

    const history: string[] = [];
    let lastSignature = "";
    let repeats = 0;
    for (;;) {
      await runLog.snapshot(fixIterations, projectDir);
      await enter("CHECK", { iteration: outcome.fixIterations });
      let result = await o.check(projectDir);
      if (result.ok) {
        const conformance = await specConformance(projectDir, ctx.spec);
        if (conformance.length) result = { ...result, ok: false, failedStage: "validate", validate: { ok: false, durationMs: 0, diagnostics: conformance } };
      }
      await runLog.check(fixIterations, result);

      const tampered = sameFingerprint(locked, await lockedFingerprint(projectDir));
      if (tampered.length) return { ok: false, status: "error", reason: `locked files changed: ${tampered.join(", ")}`, check: result };
      if (result.ok) return { ok: true, check: result };

      log(`check failed: ${failureSummary(result)}`);
      if (outcome.fixIterations >= maxFix) return { ok: false, status: "stuck", reason: `fix limit of ${maxFix} iterations reached`, check: result };
      const signature = failureSignature(result);
      repeats = signature === lastSignature ? repeats + 1 : 1;
      lastSignature = signature;
      if (repeats >= stuckAfter) return { ok: false, status: "stuck", reason: `same failure ${repeats} times in a row`, check: result };
      const route = repeats >= escalateAfter ? "fix_escalation" : "fix";

      outcome.fixIterations++;
      fixIterations++;
      await enter("FIX", { iteration: fixIterations, route, note: `#${outcome.fixIterations} via ${o.gateway.profileFor(route)}${repeats > 1 ? ` (same failure x${repeats})` : ""}` });
      const fix = await fixProject(ctx, { check: result, route, history: history.slice(-5), iteration: fixIterations });
      disputes.push(...fix.disputes);
      log(`Fixer changed ${fix.changed.length ? fix.changed.join(", ") : "nothing"}${fix.explanation ? ` — ${fix.explanation.split("\n")[0]}` : ""}`);
      history.push(
        `#${outcome.fixIterations}: ${failureSummary(result)} → changed ${fix.changed.join(", ") || "nothing"}` +
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
  };

  /** REPORT + delivery of a green state (all phases, or the last green one). */
  const report = async (deliveredSpec: PluginSpec, check: CheckResult) => {
    await enter("REPORT");
    const ctx: StageContext = { spec: deliveredSpec, projectDir, gateway: o.gateway, paperApi: o.paperApi, pluginApiVersion: o.pluginApiVersion, log };
    const untested = specGaps(deliveredSpec, specLanguage(deliveredSpec));
    try {
      untested.push(...(await reviewCoverage(ctx)));
    } catch (err) {
      // A failed audit must not cost the user a working plugin; the spec gaps still go in.
      if (err instanceof BudgetExceededError) throw err;
      log(`Reporter: coverage review failed (${(err as Error).message}); listing spec gaps only`);
    }
    log(`Reporter: ${untested.length} thing(s) not covered by tests`);
    const coverage = await coverageOf(deliveredSpec, projectDir);
    const delivery = await deliver(projectDir, deliveredSpec, check, { paperVersion: o.minecraftVersion, coverage, untested, phases: multi ? outcomes : undefined });
    return { coverage, delivery };
  };

  const greenLine = (r: CheckResult) => {
    const t = r.test;
    const l = r.live;
    return `L0+L1${l ? "+L2" : ""} green, ${t?.passed}/${t?.total} tests${l ? `, ${l.passed}/${l.total} live scenarios` : ""}`;
  };

  let failure: { status: "stuck" | "error"; reason: string; check?: CheckResult } | undefined;
  try {
    await enter("SCAFFOLD", { note: projectDir });
    await scaffoldPlugin(projectDir, { name: spec.name, packageName: spec.package, mainClass: spec.mainClass, description: spec.description });

    for (let i = 0; i < plan.length; i++) {
      const outcome = outcomes[i]!;
      const previous = i > 0 ? spec : undefined;
      try {
        if (previous) {
          await saveGreen(projectDir);
          spec = await o.nextSpec!(i, previous);
        }
        // The approved spec travels with the project (for the user, and for later changes).
        await writeFile(path.join(projectDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
        const known = new Set(previous?.acceptance.map((a) => a.id) ?? []);
        const newCriteria = spec.acceptance.filter((a) => !known.has(a.id));
        outcome.criteria = newCriteria.map((a) => a.id);
        if (multi) await enter("PHASE", { note: `${i + 1}/${plan.length} ${plan[i]!.title}: ${newCriteria.map((a) => a.id).join(", ")}` });
        const ctx: StageContext = {
          spec,
          projectDir,
          gateway: o.gateway,
          paperApi: o.paperApi,
          pluginApiVersion: o.pluginApiVersion,
          log,
          phase: multi ? { index: i, total: plan.length, title: plan[i]!.title, goal: plan[i]!.goal, newCriteria } : undefined,
        };
        const r = await buildPhase(ctx, outcome, i === 0);
        if (r.ok) {
          outcome.status = "done";
          green = { spec, check: r.check };
          log(`phase ${i + 1}/${plan.length} green: ${greenLine(r.check)}`);
          continue;
        }
        outcome.status = "failed";
        outcome.reason = r.reason;
        failure = { status: r.status, reason: r.reason, check: r.check };
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          outcome.status = "failed";
          outcome.reason = err.message;
          failure = { status: "stuck", reason: err.message };
        } else {
          outcome.status = "failed";
          outcome.reason = (err as Error).message;
          failure = { status: "error", reason: (err as Error).message };
        }
      }
      break;
    }

    if (!failure && green) {
      const { coverage, delivery } = await report(green.spec, green.check);
      return finish({ status: "done", reason: `${multi ? `all ${plan.length} phases, ` : ""}${greenLine(green.check)}`, fixIterations, check: green.check, disputes, coverage, phases: outcomes, spec: green.spec, delivery });
    }
    const failedAt = outcomes.findIndex((p) => p.status === "failed");
    if (!green || !existsSync(greenFolder(projectDir))) {
      return finish({ status: failure?.status ?? "error", reason: failure?.reason, fixIterations, check: failure?.check, disputes, phases: outcomes });
    }

    // A later phase failed: give the user the last green plugin rather than nothing.
    await enter("ROLLBACK", { note: `phase ${failedAt + 1} failed (${failure?.reason ?? "unknown"}); restoring phase ${failedAt}` });
    await restoreGreen(projectDir);
    const recheck = await o.check(projectDir);
    if (!recheck.ok) {
      return finish({ status: "error", reason: `phase ${failedAt + 1} failed and the restored phase ${failedAt} is no longer green`, fixIterations, check: recheck, disputes, phases: outcomes });
    }
    const { coverage, delivery } = await report(green.spec, recheck);
    return finish({
      status: "partial",
      reason: `phases 1-${failedAt} delivered; phase ${failedAt + 1} "${plan[failedAt]!.title}" failed: ${failure?.reason ?? "unknown"}`,
      fixIterations,
      check: recheck,
      disputes,
      coverage,
      phases: outcomes,
      spec: green.spec,
      delivery,
    });
  } catch (err) {
    // Failures outside a phase (scaffold, report, rollback).
    const status = err instanceof BudgetExceededError ? "stuck" : "error";
    return finish({ status, reason: (err as Error).message, fixIterations, check: green?.check, disputes, phases: outcomes });
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
