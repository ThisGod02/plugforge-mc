import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { downloadFile, type Log } from "./download.ts";
import { homePaths } from "./paths.ts";

export interface JavaRuntime {
  executable: string;
  /** JDK root, passed as JAVA_HOME to tools like Gradle. */
  home: string;
  feature: number;
  source: "JAVA_HOME" | "PATH" | "bundled";
}

const javaBin = process.platform === "win32" ? "java.exe" : "java";

/** Returns the Java feature version (e.g. 21) and home of an executable, or undefined if it can't run. */
function probeJava(executable: string): { feature: number; home: string } | undefined {
  const res = spawnSync(executable, ["-XshowSettings:properties", "-version"], { encoding: "utf8", windowsHide: true });
  if (res.error || res.status !== 0) return undefined;
  const out = res.stderr ?? "";
  const spec = /java\.specification\.version = (\d+)(?:\.(\d+))?/.exec(out);
  const home = /java\.home = (.+)/.exec(out)?.[1]?.trim();
  if (!spec || !home) return undefined;
  const major = Number(spec[1]);
  // Java 8 and older report "1.8".
  return { feature: major === 1 ? Number(spec[2]) : major, home };
}

async function findBundledJava(): Promise<string | undefined> {
  const root = homePaths.jdk();
  if (!existsSync(root)) return undefined;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // macOS archives nest the JDK under Contents/Home.
    for (const candidate of [
      path.join(root, entry.name, "bin", javaBin),
      path.join(root, entry.name, "Contents", "Home", "bin", javaBin),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function adoptiumPlatform(): { os: string; arch: string } {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  return { os, arch };
}

function extract(archive: string, dest: string): Promise<void> {
  // bsdtar ships with Windows 10+ and handles .zip as well as .tar.gz.
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", dest], { stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}

async function downloadTemurin(feature: number, log: Log): Promise<string> {
  const { os, arch } = adoptiumPlatform();
  const api = `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?os=${os}&architecture=${arch}&image_type=jdk&vendor=eclipse`;
  const res = await fetch(api);
  if (!res.ok) throw new Error(`Adoptium API failed: ${res.status}`);
  const assets = (await res.json()) as Array<{ binary: { package: { link: string; name: string; checksum: string } } }>;
  const pkg = assets[0]?.binary.package;
  if (!pkg) throw new Error(`no Temurin ${feature} build for ${os}/${arch}`);

  const archive = path.join(homePaths.downloads(), pkg.name);
  log(`downloading Temurin JDK ${feature} (${pkg.name})`);
  await downloadFile(pkg.link, archive, pkg.checksum, log);

  await mkdir(homePaths.jdk(), { recursive: true });
  log("extracting JDK");
  await extract(archive, homePaths.jdk());
  await rm(archive, { force: true });

  const java = await findBundledJava();
  if (!java) throw new Error("JDK extracted but java executable not found");
  return java;
}

/** Finds a Java runtime that satisfies `minFeature`, downloading Temurin into the PlugForge home if needed. */
export async function ensureJava(minFeature: number, log: Log): Promise<JavaRuntime> {
  const candidates: Array<{ executable: string; source: JavaRuntime["source"] }> = [];
  if (process.env.JAVA_HOME) candidates.push({ executable: path.join(process.env.JAVA_HOME, "bin", javaBin), source: "JAVA_HOME" });
  candidates.push({ executable: "java", source: "PATH" });
  const bundled = await findBundledJava();
  if (bundled) candidates.push({ executable: bundled, source: "bundled" });

  for (const c of candidates) {
    const probe = probeJava(c.executable);
    if (probe && probe.feature >= minFeature) return { ...c, ...probe };
  }

  const executable = await downloadTemurin(minFeature, log);
  const probe = probeJava(executable);
  if (!probe) throw new Error(`downloaded JDK at ${executable} does not run`);
  return { executable, ...probe, source: "bundled" };
}
