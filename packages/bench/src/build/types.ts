export type CheckStage = "build" | "validate" | "test" | "live";

/** One problem found in a stage, compact enough to hand to the Fixer as-is. */
export interface Diagnostic {
  stage: CheckStage;
  severity: "error" | "warning";
  message: string;
  /** Project-relative path with forward slashes. */
  file?: string;
  line?: number;
  column?: number;
  /** Extra lines: the offending source line, javac symbol/location hints, a Gradle failure block. */
  detail?: string;
}

export interface TestCase {
  suite: string;
  name: string;
  status: "passed" | "failed" | "error" | "skipped";
  timeMs: number;
  message?: string;
  /** Stack trace trimmed to the frames that matter. */
  trace?: string;
}

export interface StageResult {
  ok: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
}

export interface TestStageResult extends StageResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCase[];
}

export interface ScenarioStepResult {
  /** "setup 2" or "step 5". */
  at: string;
  /** The step as written in the scenario, e.g. `click_item: "Купить"`. */
  text: string;
  ok: boolean;
  detail?: string;
}

export interface ScenarioResult {
  id: string;
  /** Project-relative scenario file. */
  file: string;
  covers: string[];
  status: "passed" | "failed";
  durationMs: number;
  steps: ScenarioStepResult[];
  /** Why it failed: expected vs. actual of the failing step, or server errors. */
  failure?: string;
  /** What the players saw around the failure: recent chat, open menu, state. */
  context?: string;
  /** Exceptions and errors the server logged during the scenario. */
  serverErrors: string[];
}

/** L2: scenarios played by bots on a real Paper server. */
export interface LiveStageResult extends StageResult {
  total: number;
  passed: number;
  failed: number;
  /** Not played: the scenarios played first (new or earlier failures) failed, so the run stopped early. */
  notPlayed?: number;
  scenarios: ScenarioResult[];
}

export interface CheckResult {
  ok: boolean;
  failedStage?: CheckStage;
  build: StageResult & { jar?: string };
  validate?: StageResult;
  test?: TestStageResult;
  /** Present when live tests ran (L1 green, scenarios exist, EULA accepted). */
  live?: LiveStageResult;
}
