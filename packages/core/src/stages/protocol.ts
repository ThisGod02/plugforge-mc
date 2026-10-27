import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { editablePath, writeProjectFile } from "../workspace/files.ts";

/**
 * Edit format the Fixer answers in. Plain-text markers rather than JSON, because cheap models
 * mangle escaping when code is put inside JSON strings.
 *
 *   FILE: src/main/java/.../Foo.java        whole-file write
 *   ```java
 *   ...
 *   ```
 *
 *   <<<<<<< SEARCH src/main/java/.../Foo.java   targeted replace
 *   old lines
 *   =======
 *   new lines
 *   >>>>>>> REPLACE
 */
export type FileEdit = { kind: "write"; path: string; content: string } | { kind: "replace"; path: string; search: string; replace: string };

// Models decorate the marker: "FILE: x", "**FILE:** x", "## FILE: x", "### **FILE: `x`**".
const FILE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?FILE:\s*(?:\*\*)?\s*`?([^`*\s]+)`?(?:\*\*)?\s*$/;
const SEARCH = /^\s*<{5,}\s*SEARCH\s+`?([^`\s]+)`?\s*$/;
const DIVIDER = /^\s*={5,}\s*$/;
const REPLACE = /^\s*>{5,}\s*REPLACE\s*$/;
const FENCE = /^\s*```/;

export interface ParsedEdits {
  edits: FileEdit[];
  /** Malformed blocks, reported back to the model. */
  errors: string[];
}

export function parseEdits(text: string): ParsedEdits {
  const lines = text.split(/\r?\n/);
  const edits: FileEdit[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const file = FILE.exec(lines[i]!);
    if (file) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      if (!FENCE.test(lines[j] ?? "")) {
        errors.push(`FILE: ${file[1]} is not followed by a fenced code block`);
        continue;
      }
      const body: string[] = [];
      let k = j + 1;
      while (k < lines.length && !/^\s*```\s*$/.test(lines[k]!)) body.push(lines[k++]!);
      if (k >= lines.length) errors.push(`FILE: ${file[1]}: code block is not closed`);
      else edits.push({ kind: "write", path: file[1]!, content: body.join("\n") });
      i = k;
      continue;
    }

    const search = SEARCH.exec(lines[i]!);
    if (search) {
      const before: string[] = [];
      const after: string[] = [];
      let k = i + 1;
      while (k < lines.length && !DIVIDER.test(lines[k]!)) before.push(lines[k++]!);
      k++;
      while (k < lines.length && !REPLACE.test(lines[k]!)) after.push(lines[k++]!);
      if (k >= lines.length) errors.push(`SEARCH block for ${search[1]} has no ======= / >>>>>>> REPLACE`);
      else edits.push({ kind: "replace", path: search[1]!, search: before.join("\n"), replace: after.join("\n") });
      i = k;
    }
  }
  return { edits, errors };
}

/** Content of the first fenced code block, or the whole reply when the model skipped the fence. */
export function extractCodeBlock(text: string): string {
  const m = /```[\w.+-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(text);
  return (m ? m[1]! : text).replace(/\r\n/g, "\n").trim();
}

/** Parses the first JSON object in a reply (tolerates ```json fences and surrounding prose). */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
  const raw = fenced ? fenced[1]! : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw) as T;
}

/** Finds `search` in `content`: exact first, then ignoring trailing whitespace and line endings. */
function locate(content: string, search: string): { start: number; end: number } | "missing" | "ambiguous" {
  const exact = content.indexOf(search);
  if (exact >= 0) return content.indexOf(search, exact + 1) >= 0 ? "ambiguous" : { start: exact, end: exact + search.length };

  const norm = (l: string) => l.trimEnd();
  const lines = content.split("\n");
  const want = search.split(/\r?\n/).map(norm);
  while (want.length && want[want.length - 1] === "") want.pop();
  while (want.length && want[0] === "") want.shift();
  if (want.length === 0) return "missing";

  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => norm(lines[i + k]!) === w)) hits.push(i);
  }
  if (hits.length === 0) return "missing";
  if (hits.length > 1) return "ambiguous";
  const first = hits[0]!;
  const last = first + want.length - 1;
  return { start: offsets[first]!, end: offsets[last]! + lines[last]!.length };
}

export interface ApplyResult {
  changed: string[];
  errors: string[];
}

/**
 * Applies edits under a path policy (main sources by default, test sources for TestWriter).
 * Each failed edit is reported, the rest still apply.
 */
export async function applyEdits(projectDir: string, edits: FileEdit[], policy: (raw: string) => string = editablePath): Promise<ApplyResult> {
  const changed = new Set<string>();
  const errors: string[] = [];
  for (const edit of edits) {
    let rel: string;
    try {
      rel = policy(edit.path);
    } catch (err) {
      errors.push((err as Error).message);
      continue;
    }
    const file = path.join(projectDir, rel);
    if (edit.kind === "write") {
      await writeProjectFile(projectDir, rel, edit.content);
      changed.add(rel);
      continue;
    }
    if (!existsSync(file)) {
      errors.push(`${rel}: file does not exist (use FILE: to create it)`);
      continue;
    }
    const content = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    if (edit.search.trim() === "") {
      errors.push(`${rel}: empty SEARCH block`);
      continue;
    }
    const at = locate(content, edit.search.replace(/\r\n/g, "\n"));
    if (at === "missing") errors.push(`${rel}: SEARCH text not found; copy it exactly from the current file`);
    else if (at === "ambiguous") errors.push(`${rel}: SEARCH text matches more than once; include more surrounding lines`);
    else {
      await writeProjectFile(projectDir, rel, content.slice(0, at.start) + edit.replace + content.slice(at.end));
      changed.add(rel);
    }
  }
  return { changed: [...changed], errors };
}
