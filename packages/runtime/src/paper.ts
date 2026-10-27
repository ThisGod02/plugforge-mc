import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile, type Log } from "./download.ts";
import type { JavaRuntime } from "./java.ts";
import { homePaths } from "./paths.ts";
import type { BenchVersions } from "./versions.ts";

export interface PaperInstall {
  /** The original paperclip jar. */
  jar: string;
  /** Folder where paperclip downloaded the Mojang jar, libraries and the patched server. */
  baseDir: string;
  /**
   * Test servers launch the patched server directly with this classpath instead of going through
   * paperclip, so every server folder starts empty and nothing is re-downloaded or re-patched.
   */
  mainClass: string;
  classpath: string[];
}

interface LaunchInfo {
  mainClass: string;
  classpath: string[];
}

function runPatchOnly(java: JavaRuntime, jar: string, cwd: string, log: Log): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(java.executable, ["-Dpaperclip.patchonly=true", "-jar", jar], { cwd, windowsHide: true });
    const forward = (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/)) if (line.trim()) log(`  [paperclip] ${line}`);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`paperclip exited with ${code}`))));
  });
}

/** Reads a text entry from a jar; bsdtar (bundled with Windows 10+, macOS, Linux) reads zip files. */
function readJarEntry(jar: string, entry: string): string {
  const res = spawnSync("tar", ["-xOf", jar, entry], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0) throw new Error(`cannot read ${entry} from ${jar}: ${res.stderr}`);
  return res.stdout.trim();
}

async function jarsUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jar"))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

async function buildLaunchInfo(jar: string, baseDir: string): Promise<LaunchInfo> {
  const mainClass = readJarEntry(jar, "META-INF/main-class");
  // The patched server goes first so its classes win over anything bundled in libraries.
  const classpath = [...(await jarsUnder(path.join(baseDir, "versions"))), ...(await jarsUnder(path.join(baseDir, "libraries")))];
  if (!mainClass || classpath.length === 0) throw new Error(`incomplete Paper install in ${baseDir}`);
  return { mainClass, classpath };
}

export async function ensurePaper(versions: BenchVersions, java: JavaRuntime, log: Log): Promise<PaperInstall> {
  const { version, build, sha256, url } = versions.paper;
  const jar = path.join(homePaths.paper(), `paper-${version}-${build}.jar`);
  log(`checking Paper ${version} build ${build}`);
  await downloadFile(url, jar, sha256, log);

  const baseDir = path.join(homePaths.paper(), `base-${version}-${build}`);
  const launchFile = path.join(baseDir, "launch.json");
  if (!existsSync(launchFile)) {
    await mkdir(baseDir, { recursive: true });
    if (!existsSync(path.join(baseDir, "versions"))) {
      log("patching Paper (one-time, downloads the Mojang server jar)");
      await runPatchOnly(java, jar, baseDir, log);
    }
    await writeFile(launchFile, JSON.stringify(await buildLaunchInfo(jar, baseDir), null, 2));
  }
  const launch = JSON.parse(await readFile(launchFile, "utf8")) as LaunchInfo;
  return { jar, baseDir, ...launch };
}
