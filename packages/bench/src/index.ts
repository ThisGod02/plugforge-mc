import { fileURLToPath } from "node:url";

export { checkProject, type CheckOptions } from "./build/check.ts";
export { formatCheckResult } from "./build/format.ts";
export { runGradle, type GradleRunResult } from "./build/gradle.ts";
export { parseJavacDiagnostics } from "./build/javac.ts";
export { parseJUnitReports, trimTrace } from "./build/junit.ts";
export { validatePluginYml } from "./build/pluginYml.ts";
export type { CheckResult, CheckStage, Diagnostic, StageResult, TestCase, TestStageResult } from "./build/types.ts";
export { connectBot, type ConnectBotOptions } from "./live/bot.ts";
export { freePort } from "./live/ports.ts";
export { TestServer, type StartServerOptions } from "./live/server.ts";

/** Known-good and known-broken plugin overlays used by `plugforge selftest`. */
export const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
