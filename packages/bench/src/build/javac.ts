import path from "node:path";
import type { CheckStage, Diagnostic } from "./types.ts";

// Gradle 9 repeats compiler output, indented, in its failure summary; leading whitespace is allowed
// and duplicates are dropped below.
const HEADER = /^\s*(.*?\.java):(\d+): (error|warning): (.*)$/;
// Lines that end a diagnostic's detail block.
const BOUNDARY = /^(\d+ (errors?|warnings?)$|> Task |FAILURE:|\* |BUILD |Note: |\[Incubating\])/;

/** Parses javac diagnostics out of Gradle output (requires English compiler messages). */
export function parseJavacDiagnostics(output: string, projectDir: string, stage: CheckStage): Diagnostic[] {
  const lines = output.split(/\r?\n/);
  const result: Diagnostic[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]!);
    if (!m) continue;
    const [, file, line, severity, message] = m;
    const relFile = path.relative(projectDir, path.resolve(projectDir, file!)).replaceAll("\\", "/");
    const key = `${relFile}:${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const detail: string[] = [];
    let column: number | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (HEADER.test(next) || BOUNDARY.test(next)) break;
      // javac prints the source line, then a caret under the column.
      if (column === undefined && /^\s*\^\s*$/.test(next)) column = next.indexOf("^") + 1;
      detail.push(next);
    }

    result.push({
      stage,
      severity: severity as Diagnostic["severity"],
      message: message!,
      file: relFile,
      line: Number(line),
      column,
      detail: detail.join("\n").trimEnd() || undefined,
    });
  }
  return result;
}
