import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Paths the Coder and Fixer may write. Tests and build files are locked (PLAN.md §6.3). */
const EDITABLE = /^src\/main\/(java|resources)\/[A-Za-z0-9_./-]+$/;

/** Normalises a model-supplied path to project-relative with forward slashes, or throws. */
export function editablePath(raw: string): string {
  const rel = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`path '${raw}' leaves the project`);
  if (!EDITABLE.test(rel)) {
    throw new Error(
      rel.startsWith("src/test/")
        ? `path '${rel}' is a test file; tests are fixed and must not be changed`
        : `path '${rel}' is outside src/main/java and src/main/resources`,
    );
  }
  return rel;
}

const TEST_SOURCE = /^src\/test\/java\/[A-Za-z0-9_./-]+\.java$/;

/** Path policy for TestWriter and TestReview: Java test sources only. */
export function testPath(raw: string): string {
  const rel = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`path '${raw}' leaves the project`);
  if (!TEST_SOURCE.test(rel)) throw new Error(`path '${rel}' is not a Java test source under src/test/java`);
  return rel;
}

export async function listFiles(projectDir: string, sub: string): Promise<string[]> {
  const root = path.join(projectDir, sub);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(projectDir, path.join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();
}

/** Project-relative path → content, for every file under `sub`. */
export async function readTree(projectDir: string, sub: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await listFiles(projectDir, sub)) out.set(rel, await readFile(path.join(projectDir, rel), "utf8"));
  return out;
}

export async function writeProjectFile(projectDir: string, rel: string, content: string): Promise<void> {
  const file = path.join(projectDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content.endsWith("\n") ? content : `${content}\n`);
}

/** Hashes of locked files, to prove after each fix that tests and build files were not touched. */
export async function lockedFingerprint(projectDir: string): Promise<Map<string, string>> {
  const files = [...(await listFiles(projectDir, "src/test")), "build.gradle.kts", "settings.gradle.kts"];
  const out = new Map<string, string>();
  for (const rel of files) {
    const file = path.join(projectDir, rel);
    if (existsSync(file)) out.set(rel, createHash("sha256").update(await readFile(file)).digest("hex"));
  }
  return out;
}

export function fenceFor(rel: string): string {
  const ext = path.extname(rel).slice(1);
  return ({ java: "java", yml: "yaml", yaml: "yaml", kts: "kotlin", json: "json", properties: "properties" } as Record<string, string>)[ext] ?? "";
}

/** Files rendered for a prompt as "### path" + fenced content. */
export function renderFiles(files: Map<string, string>): string {
  return [...files].map(([rel, content]) => `### ${rel}\n\`\`\`${fenceFor(rel)}\n${content.trimEnd()}\n\`\`\``).join("\n\n");
}
