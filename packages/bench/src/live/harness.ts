import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plugforgeHome, type GradleInstall, type JavaRuntime, type Log } from "@plugforge/runtime";
import { runGradle } from "../build/gradle.ts";

const sourceDir = fileURLToPath(new URL("../../../../java/harness-plugin", import.meta.url));

async function sources(): Promise<string[]> {
  const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !path.relative(sourceDir, e.parentPath).split(path.sep).includes("build"))
    .map((e) => path.relative(sourceDir, path.join(e.parentPath, e.name)))
    .sort();
}

/**
 * Builds java/harness-plugin once per source version (cached under <PlugForge>/harness/<hash>)
 * and returns the jar that live tests load next to the plugin under test.
 */
export async function ensureHarness(opts: {
  java: JavaRuntime;
  gradle: GradleInstall;
  paperApi: string;
  pluginApiVersion: string;
  log?: Log;
}): Promise<string> {
  const tokens: Record<string, string> = { paperApi: opts.paperApi, pluginApiVersion: opts.pluginApiVersion };
  const files = await sources();
  const hash = createHash("sha256");
  for (const rel of files) hash.update(rel).update(await readFile(path.join(sourceDir, rel)));
  hash.update(JSON.stringify(tokens));
  const dir = path.join(plugforgeHome(), "harness", hash.digest("hex").slice(0, 12));
  const jar = path.join(dir, "build", "libs", "PlugForgeHarness-1.0.0.jar");
  if (existsSync(jar)) return jar;

  opts.log?.(`building the test harness plugin (one-time)`);
  await rm(dir, { recursive: true, force: true });
  for (const rel of files) {
    const text = (await readFile(path.join(sourceDir, rel), "utf8")).replace(/\{\{(\w+)\}\}/g, (m, k: string) => tokens[k] ?? m);
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  const run = await runGradle({ gradle: opts.gradle, java: opts.java, projectDir: dir, tasks: ["jar"] });
  if (run.exitCode !== 0 || !existsSync(jar)) {
    throw new Error(`could not build the harness plugin:\n${run.failure ?? run.output.split(/\r?\n/).slice(-30).join("\n")}`);
  }
  return jar;
}
