import type { CheckResult, Diagnostic, StageResult } from "./types.ts";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const indent = (text: string, pad = "      ") => text.replace(/^/gm, pad);

function formatDiagnostic(d: Diagnostic): string {
  const where = d.file ? ` ${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : ""}` : "";
  const head = `  ${d.severity}${where}: ${d.message}`;
  return d.detail ? `${head}\n${indent(d.detail)}` : head;
}

function stageLine(label: string, stage: StageResult | undefined, extra = ""): string {
  if (!stage) return `${label.padEnd(9)}skipped`;
  return `${label.padEnd(9)}${stage.ok ? "ok" : "FAILED"} (${secs(stage.durationMs)})${extra}`;
}

/** Human- and LLM-readable summary of a check run. */
export function formatCheckResult(r: CheckResult): string {
  const out: string[] = [];

  out.push(stageLine("BUILD", r.build, r.build.jar ? `  jar: ${r.build.jar}` : ""));
  out.push(...r.build.diagnostics.map(formatDiagnostic));

  out.push(stageLine("VALIDATE", r.validate));
  out.push(...(r.validate?.diagnostics ?? []).map(formatDiagnostic));

  const t = r.test;
  out.push(stageLine("TEST", t, t ? `  ${t.passed}/${t.total} passed${t.skipped ? `, ${t.skipped} skipped` : ""}` : ""));
  out.push(...(t?.diagnostics ?? []).map(formatDiagnostic));
  for (const c of t?.cases ?? []) {
    if (c.status !== "failed" && c.status !== "error") continue;
    out.push(`  FAIL ${c.suite}.${c.name}${c.message ? `: ${c.message}` : ""}`);
    // The trace usually starts with "ExceptionType: message", which the line above already shows.
    const trace = c.message && c.trace?.split("\n")[0]?.includes(c.message) ? c.trace.split("\n").slice(1).join("\n") : c.trace;
    if (trace) out.push(indent(trace));
  }

  out.push(r.ok ? "RESULT   OK" : `RESULT   FAILED at ${r.failedStage}`);
  return out.join("\n");
}
