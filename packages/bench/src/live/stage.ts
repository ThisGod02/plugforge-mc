import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { loadSettings, type GradleInstall, type JavaRuntime, type Log, type PaperInstall } from "@plugforge/runtime";
import type { CheckResult } from "../build/types.ts";
import { ensureHarness } from "./harness.ts";
import { runLiveTests } from "./runner.ts";
import { loadScenarios } from "./scenario.ts";

export interface LiveStageOptions {
  projectDir: string;
  java: JavaRuntime;
  gradle: GradleInstall;
  paper: PaperInstall;
  paperApi: string;
  pluginApiVersion: string;
  minecraftVersion: string;
  /** Acceptance ids, to reject scenarios that cover unknown criteria. */
  criteria?: string[];
  log?: Log;
}

export interface LiveStageOutcome {
  result: CheckResult;
  /** Why L2 did not run although the project has scenarios (shown to the user, never silent). */
  skipped?: string;
}

/**
 * L2 on top of a green L0+L1 result: plays the project's scenarios on a real server. Returns
 * the result unchanged when L1 failed or there are no scenarios.
 */
export async function liveStage(l1: CheckResult, o: LiveStageOptions): Promise<LiveStageOutcome> {
  if (!l1.ok || !l1.build.jar) return { result: l1 };
  const { scenarios, errors } = await loadScenarios(o.projectDir, o.criteria);
  for (const [file, errs] of errors) o.log?.(`warning: scenario ${file} is invalid and was skipped: ${errs.join("; ")}`);
  if (scenarios.length === 0) return { result: l1, skipped: errors.size ? "every scenario file is invalid" : undefined };
  if (!(await loadSettings()).eulaAcceptedAt) {
    return { result: l1, skipped: "the Minecraft EULA is not accepted (run `plugforge smoke --accept-eula` once)" };
  }
  const harnessJar = await ensureHarness({ java: o.java, gradle: o.gradle, paperApi: o.paperApi, pluginApiVersion: o.pluginApiVersion, log: o.log });
  const pluginYml = parse(await readFile(path.join(o.projectDir, "build", "resources", "main", "plugin.yml"), "utf8")) as { name: string };
  o.log?.(`L2: playing ${scenarios.length} scenario(s) on a real Paper server`);
  const live = await runLiveTests({
    java: o.java,
    paper: o.paper,
    harnessJar,
    pluginJar: l1.build.jar,
    pluginName: pluginYml.name,
    minecraftVersion: o.minecraftVersion,
    scenarios,
    log: o.log,
  });
  return { result: live.ok ? { ...l1, live } : { ...l1, ok: false, failedStage: "live", live } };
}
