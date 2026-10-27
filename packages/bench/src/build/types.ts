export type CheckStage = "build" | "validate" | "test";

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

export interface CheckResult {
  ok: boolean;
  failedStage?: CheckStage;
  build: StageResult & { jar?: string };
  validate?: StageResult;
  test?: TestStageResult;
}
