import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { checkProject, fixturesDir, formatCheckResult, type CheckResult, type CheckStage } from "@plugforge/bench";
import { scaffoldPlugin, type ScaffoldOptions } from "@plugforge/core";
import { plugforgeHome, type GradleInstall, type JavaRuntime, type Log } from "@plugforge/runtime";

interface FixtureExpect {
  ok: boolean;
  failedStage?: CheckStage;
  minTests?: number;
  /** "path:line" of a diagnostic that must be reported. */
  diagnosticAt?: string;
  diagnosticContains?: string;
  failedTest?: string;
  /** Guards against a test failing for an unrelated reason (e.g. plugin failed to load). */
  failedTestMessageContains?: string;
}

interface Fixture {
  name: string;
  description: string;
  extends?: string;
  scaffold?: ScaffoldOptions;
  expect: FixtureExpect;
}

async function loadFixture(name: string): Promise<Fixture> {
  const file = path.join(fixturesDir, name, "fixture.json");
  return { name, ...(JSON.parse(await readFile(file, "utf8")) as Omit<Fixture, "name">) };
}

/** Builds the fixture project: scaffold the root of the `extends` chain, then overlay each fixture's files. */
async function materialize(fixture: Fixture, dir: string): Promise<void> {
  const chain: Fixture[] = [fixture];
  while (chain[0]!.extends) chain.unshift(await loadFixture(chain[0]!.extends));
  const root = chain[0]!;
  if (!root.scaffold) throw new Error(`fixture ${root.name} has no scaffold options`);
  await scaffoldPlugin(dir, root.scaffold);
  for (const f of chain) {
    const files = path.join(fixturesDir, f.name, "files");
    if (existsSync(files)) await cp(files, dir, { recursive: true, force: true });
  }
}

function verify(r: CheckResult, e: FixtureExpect): string[] {
  const problems: string[] = [];
  if (r.ok !== e.ok) problems.push(`expected ok=${e.ok}, got ok=${r.ok}${r.failedStage ? ` (failed at ${r.failedStage})` : ""}`);
  if (e.failedStage && r.failedStage !== e.failedStage) problems.push(`expected failure at ${e.failedStage}, got ${r.failedStage ?? "none"}`);

  const diagnostics = [...r.build.diagnostics, ...(r.validate?.diagnostics ?? []), ...(r.test?.diagnostics ?? [])];
  if (e.diagnosticAt && !diagnostics.some((d) => `${d.file}:${d.line}` === e.diagnosticAt)) {
    problems.push(`no diagnostic at ${e.diagnosticAt}`);
  }
  if (e.diagnosticContains && !diagnostics.some((d) => d.message.includes(e.diagnosticContains!))) {
    problems.push(`no diagnostic containing "${e.diagnosticContains}"`);
  }
  if (e.failedTest) {
    const tc = r.test?.cases.find((c) => c.name === e.failedTest && (c.status === "failed" || c.status === "error"));
    if (!tc) problems.push(`test ${e.failedTest} was not reported as failed`);
    else if (e.failedTestMessageContains && !tc.message?.includes(e.failedTestMessageContains)) {
      problems.push(`test ${e.failedTest} failed for another reason: ${tc.message}`);
    }
  }
  if (e.minTests !== undefined && (r.test?.total ?? 0) < e.minTests) {
    problems.push(`expected at least ${e.minTests} tests, got ${r.test?.total ?? 0}`);
  }
  return problems;
}

export interface SelftestOptions {
  java: JavaRuntime;
  gradle: GradleInstall;
  pluginApiVersion: string;
  log: Log;
  only?: string;
  keep?: boolean;
  verbose?: boolean;
}

/** Runs every fixture through the real check pipeline and compares the outcome with fixture.json. */
export async function runSelftest(opts: SelftestOptions): Promise<boolean> {
  const names = (await readdir(fixturesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && (!opts.only || e.name === opts.only))
    .map((e) => e.name)
    .sort((a, b) => (a === "hello-ok" ? -1 : b === "hello-ok" ? 1 : a.localeCompare(b)));
  if (names.length === 0) throw new Error(opts.only ? `no fixture named ${opts.only}` : "no fixtures found");

  const summary: string[] = [];
  for (const name of names) {
    const fixture = await loadFixture(name);
    const dir = path.join(plugforgeHome(), "selftest", `${name}-${randomBytes(3).toString("hex")}`);
    opts.log(`--- fixture ${name}: ${fixture.description}`);
    try {
      await materialize(fixture, dir);
      const result = await checkProject({
        projectDir: dir,
        java: opts.java,
        gradle: opts.gradle,
        pluginApiVersion: opts.pluginApiVersion,
        log: opts.log,
        verbose: opts.verbose,
      });
      console.log(formatCheckResult(result));
      const problems = verify(result, fixture.expect);
      summary.push(problems.length ? `FAIL ${name}\n${problems.map((p) => `       - ${p}`).join("\n")}` : `PASS ${name}`);
    } catch (err) {
      summary.push(`FAIL ${name}\n       - ${(err as Error).message}`);
    } finally {
      if (opts.keep) opts.log(`kept ${dir}`);
      else await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }

  console.log(`\n=== selftest ===\n${summary.join("\n")}`);
  return summary.every((s) => s.startsWith("PASS"));
}
