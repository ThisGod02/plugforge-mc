import { cp, readdir } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, Diagnostic } from "@plugforge/bench";
import type { Log } from "@plugforge/runtime";
import { BudgetExceededError, type LlmGateway } from "../llm/gateway.ts";
import type { PluginSpec } from "../spec/spec.ts";
import { writeProject } from "../stages/coder.ts";
import type { StageContext } from "../stages/context.ts";
import { fixProject } from "../stages/fixer.ts";
import { scaffoldPlugin } from "../workspace/scaffold.ts";
import { listFiles, lockedFingerprint } from "../workspace/files.ts";
import { specConformance } from "./conformance.ts";
import type { RunLog } from "./runlog.ts";

export type AgentState = "SCAFFOLD" | "CODE_WRITE" | "CHECK" | "FIX" | "DONE" | "STUCK" | "ERROR";

export interface AgentOptions {
  spec: PluginSpec;
  /** Overlay with the fixed tests, laid out like the project (`src/test/java/...`). */
  testsDir?: string;
  /** Must not exist or be empty. */
  projectDir: string;
  gateway: LlmGateway;
  /** L0 + validation + L1 on the project (the bench's checkProject). */
  check: (projectDir: string) => Promise<CheckResult>;
  runLog: RunLog;
  log: Log;
  paperApi: string;
  pluginApiVersion: string;
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
}

function errorsOf(r: CheckResult): Diagnostic[] {
  return [...r.build.diagnostics, ...(r.validate?.diagnostics ?? []), ...(r.test?.diagnostics ?? [])].filter((d) => d.severity === "error");
}

/** Identity of a failure, to notice when fixes stop making progress. */
export function failureSignature(r: CheckResult): string {
  const parts = errorsOf(r).map((d) => `${d.file ?? ""}:${d.line ?? ""}:${d.message}`);
  for (const c of r.test?.cases ?? []) if (c.status === "failed" || c.status === "error") parts.push(`${c.suite}.${c.name}:${c.message ?? ""}`);
  return `${r.failedStage}|${parts.sort().join("|")}`;
}

/** One line for the Fixer's "earlier attempts" list. */
function failureSummary(r: CheckResult): string {
  const failedTests = (r.test?.cases ?? []).filter((c) => c.status === "failed" || c.status === "error");
  if (failedTests.length) return `${failedTests.length} test(s) failed, e.g. ${failedTests[0]!.name}: ${(failedTests[0]!.message ?? "").slice(0, 160)}`;
  const errs = errorsOf(r);
  const first = errs[0];
  return `${r.failedStage} failed with ${errs.length} error(s), e.g. ${first?.file ?? ""}${first?.line ? `:${first.line}` : ""} ${first?.message ?? ""}`.trim();
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
 * Orchestrator for M2 (PLAN.md §3): a fixed state machine around the LLM stages.
 * SCAFFOLD → CODE_WRITE → CHECK ─fail→ FIX → CHECK … → DONE, or STUCK on limits.
 */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const maxFix = o.maxFixIterations ?? 8;
  const escalateAfter = o.escalateAfter ?? 3;
  const stuckAfter = o.stuckAfter ?? 5;
  const { spec, projectDir, runLog, log } = o;
  const ctx: StageContext = { spec, projectDir, gateway: o.gateway, paperApi: o.paperApi, pluginApiVersion: o.pluginApiVersion, log };
  const disputes: string[] = [];
  let fixIterations = 0;
  let last: CheckResult | undefined;

  const enter = async (state: AgentState, data: Record<string, unknown> = {}) => {
    await runLog.event(state, data);
    log(`[${state}]${data.note ? ` ${String(data.note)}` : ""}`);
  };
  const finish = async (result: AgentResult): Promise<AgentResult> => {
    await enter(result.status === "done" ? "DONE" : result.status === "stuck" ? "STUCK" : "ERROR", { note: result.reason ?? "" });
    await runLog.write({
      status: result.status,
      reason: result.reason,
      fixIterations: result.fixIterations,
      disputes: result.disputes,
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
    if (o.testsDir) log(`installed ${await installTests(o.testsDir, projectDir)} fixed test file(s)`);
    const locked = await lockedFingerprint(projectDir);

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
        return await finish({ status: "done", reason: `L0+L1 green, ${t?.passed}/${t?.total} tests`, fixIterations, check: result, disputes });
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
