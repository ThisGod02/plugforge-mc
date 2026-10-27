import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { GradleInstall, JavaRuntime, Log } from "@plugforge/runtime";
import { runGradle, type GradleRunResult } from "./gradle.ts";
import { parseJavacDiagnostics } from "./javac.ts";
import { parseJUnitReports } from "./junit.ts";
import { validatePluginYml } from "./pluginYml.ts";
import type { CheckResult, CheckStage, Diagnostic, StageResult, TestStageResult } from "./types.ts";

export interface CheckOptions {
  projectDir: string;
  java: JavaRuntime;
  gradle: GradleInstall;
  /** api-version the bench targets, e.g. "1.21". */
  pluginApiVersion: string;
  log?: Log;
  /** Print Gradle's own output lines as they arrive. */
  verbose?: boolean;
}

/** Turns a failed Gradle run into diagnostics: javac errors if any, otherwise Gradle's failure block. */
function failureDiagnostics(run: GradleRunResult, projectDir: string, stage: CheckStage): Diagnostic[] {
  const javac = parseJavacDiagnostics(run.output, projectDir, stage);
  if (javac.some((d) => d.severity === "error")) return javac;
  const message = run.timedOut ? "Gradle timed out" : `Gradle failed${run.failedTask ? ` in task ${run.failedTask}` : ""}`;
  const detail = run.failure ?? run.output.split(/\r?\n/).slice(-40).join("\n");
  return [...javac, { stage, severity: "error", message, detail }];
}

/**
 * Compiles main and test sources without running tests. TestWriter uses it to check new tests
 * against the scaffold before any plugin code exists.
 */
export async function compileTests(opts: Omit<CheckOptions, "pluginApiVersion">): Promise<StageResult> {
  const log = opts.log ?? (() => {});
  const onLine = opts.verbose ? (l: string) => log(`  | ${l}`) : undefined;
  const run = await runGradle({ gradle: opts.gradle, java: opts.java, projectDir: opts.projectDir, tasks: ["testClasses"], onLine });
  const diagnostics =
    run.exitCode === 0 ? parseJavacDiagnostics(run.output, opts.projectDir, "test") : failureDiagnostics(run, opts.projectDir, "test");
  return { ok: run.exitCode === 0, durationMs: run.durationMs, diagnostics };
}

/** L0 (compile + jar), plugin.yml validation, then L1 (MockBukkit unit tests). Stops at the first failing stage. */
export async function checkProject(opts: CheckOptions): Promise<CheckResult> {
  const { projectDir } = opts;
  const log = opts.log ?? (() => {});
  const onLine = opts.verbose ? (l: string) => log(`  | ${l}`) : undefined;
  const gradle = (tasks: string[]) => runGradle({ gradle: opts.gradle, java: opts.java, projectDir, tasks, onLine });

  log("L0: compiling and packaging");
  const build = await gradle(["jar"]);
  const buildDiagnostics =
    build.exitCode === 0 ? parseJavacDiagnostics(build.output, projectDir, "build") : failureDiagnostics(build, projectDir, "build");
  const libs = path.join(projectDir, "build", "libs");
  const jarName = build.exitCode === 0 && existsSync(libs) ? (await readdir(libs)).find((f) => f.endsWith(".jar")) : undefined;
  const result: CheckResult = {
    ok: false,
    build: {
      ok: build.exitCode === 0,
      durationMs: build.durationMs,
      diagnostics: buildDiagnostics,
      jar: jarName ? path.join(libs, jarName) : undefined,
    },
  };
  if (!result.build.ok) return { ...result, failedStage: "build" };

  log("L0: validating plugin.yml");
  const started = Date.now();
  const validateDiagnostics = await validatePluginYml(projectDir, opts.pluginApiVersion);
  result.validate = {
    ok: !validateDiagnostics.some((d) => d.severity === "error"),
    durationMs: Date.now() - started,
    diagnostics: validateDiagnostics,
  };
  if (!result.validate.ok) return { ...result, failedStage: "validate" };

  log("L1: running unit tests");
  // Stale reports from an earlier run would otherwise look like fresh results.
  await rm(path.join(projectDir, "build", "test-results", "test"), { recursive: true, force: true });
  const run = await gradle(["test"]);
  const cases = await parseJUnitReports(projectDir);
  const failed = cases.filter((c) => c.status === "failed" || c.status === "error").length;
  const skipped = cases.filter((c) => c.status === "skipped").length;
  // Tests that ran and failed already explain the failure; otherwise (test sources don't compile,
  // test JVM crashed) explain it from the Gradle output.
  const testDiagnostics = run.exitCode !== 0 && failed === 0 ? failureDiagnostics(run, projectDir, "test") : [];
  const test: TestStageResult = {
    ok: run.exitCode === 0 && failed === 0,
    durationMs: run.durationMs,
    diagnostics: testDiagnostics,
    total: cases.length,
    passed: cases.length - failed - skipped,
    failed,
    skipped,
    cases,
  };
  result.test = test;
  if (!test.ok) return { ...result, failedStage: "test" };

  return { ...result, ok: true };
}
