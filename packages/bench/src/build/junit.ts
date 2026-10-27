import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { TestCase } from "./types.ts";

interface XmlFailure {
  message?: string;
  type?: string;
  "#text"?: string;
}

interface XmlTestCase {
  name: string;
  classname: string;
  time?: string;
  failure?: XmlFailure | string;
  error?: XmlFailure | string;
  skipped?: unknown;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "testsuite" || name === "testcase",
});

// Frames from the test runner and reflection never help fix a plugin.
const NOISE = /^\s*at (org\.junit\.|org\.gradle\.|worker\.org\.gradle\.|java\.base\/jdk\.internal\.|java\.base\/java\.lang\.reflect\.|jdk\.internal\.|sun\.reflect\.|java\.base\/java\.util\.(ArrayList|stream|Spliterators))/;

export function trimTrace(trace: string, maxFrames = 12): string {
  const lines = trace.trim().split(/\r?\n/);
  const kept: string[] = [];
  let frames = 0;
  let dropped = 0;
  for (const line of lines) {
    const isFrame = /^\s*at /.test(line);
    if (isFrame && (NOISE.test(line) || frames >= maxFrames)) {
      dropped++;
      continue;
    }
    if (/^\s*\.\.\. \d+ more$/.test(line)) continue;
    if (isFrame) frames++;
    kept.push(line);
  }
  if (dropped) kept.push(`\t... ${dropped} runner/reflection frames omitted`);
  return kept.join("\n");
}

function readProblem(p: XmlFailure | string): { message?: string; trace?: string } {
  if (typeof p === "string") return { trace: trimTrace(p) };
  return { message: p.message, trace: p["#text"] ? trimTrace(p["#text"]) : undefined };
}

/** Reads every JUnit XML report Gradle wrote for the `test` task. */
export async function parseJUnitReports(projectDir: string): Promise<TestCase[]> {
  const dir = path.join(projectDir, "build", "test-results", "test");
  if (!existsSync(dir)) return [];
  const cases: TestCase[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".xml")).sort()) {
    const doc = parser.parse(await readFile(path.join(dir, file), "utf8"));
    for (const suite of doc.testsuite ?? []) {
      for (const tc of (suite.testcase ?? []) as XmlTestCase[]) {
        const problem = tc.failure ?? tc.error;
        cases.push({
          suite: tc.classname,
          name: tc.name.replace(/\(\)$/, ""),
          status: tc.failure !== undefined ? "failed" : tc.error !== undefined ? "error" : tc.skipped !== undefined ? "skipped" : "passed",
          timeMs: Math.round(Number(tc.time ?? 0) * 1000),
          ...(problem !== undefined ? readProblem(problem) : {}),
        });
      }
    }
  }
  return cases;
}
