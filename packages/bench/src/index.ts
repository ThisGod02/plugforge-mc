import { fileURLToPath } from "node:url";

export { checkProject, compileTests, type CheckOptions } from "./build/check.ts";
export { formatCheckResult } from "./build/format.ts";
export { runGradle, type GradleRunResult } from "./build/gradle.ts";
export { parseJavacDiagnostics } from "./build/javac.ts";
export { parseJUnitReports, trimTrace } from "./build/junit.ts";
export { validatePluginYml } from "./build/pluginYml.ts";
export type {
  CheckResult,
  CheckStage,
  Diagnostic,
  LiveStageResult,
  ScenarioResult,
  ScenarioStepResult,
  StageResult,
  TestCase,
  TestStageResult,
} from "./build/types.ts";
export { connectBot, type ConnectBotOptions } from "./live/bot.ts";
export { ensureHarness } from "./live/harness.ts";
export { runLiveTests, type LiveTestOptions } from "./live/runner.ts";
export { liveStage, type LiveStageOptions, type LiveStageOutcome } from "./live/stage.ts";
export { SCENARIO_DIR, loadScenarios, parseScenario, type Scenario, type Step } from "./live/scenario.ts";
export { freePort } from "./live/ports.ts";
export { TestServer, type StartServerOptions } from "./live/server.ts";

/** Known-good and known-broken plugin overlays used by `plugforge selftest`. */
export const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
