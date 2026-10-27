import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile, type Log } from "./download.ts";
import { homePaths } from "./paths.ts";
import type { BenchVersions } from "./versions.ts";

export interface GradleInstall {
  version: string;
  executable: string;
  userHome: string;
}

// Shared by every build: English compiler messages (the parser depends on them), UTF-8,
// and a short daemon idle timeout so a warm daemon doesn't linger for hours after the agent stops.
const USER_GRADLE_PROPERTIES = [
  "org.gradle.jvmargs=-Xmx1g -Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US",
  "org.gradle.daemon.idletimeout=900000",
  "org.gradle.welcome=never",
  "",
].join("\n");

function extract(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", dest], { stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}

export async function ensureGradle(versions: BenchVersions, log: Log): Promise<GradleInstall> {
  const { version, sha256, url } = versions.gradle;
  const home = path.join(homePaths.gradle(), `gradle-${version}`);
  const executable = path.join(home, "bin", process.platform === "win32" ? "gradle.bat" : "gradle");

  if (!existsSync(executable)) {
    const archive = path.join(homePaths.downloads(), `gradle-${version}-bin.zip`);
    log(`downloading Gradle ${version}`);
    await downloadFile(url, archive, sha256, log);
    await mkdir(homePaths.gradle(), { recursive: true });
    log("extracting Gradle");
    await extract(archive, homePaths.gradle());
    await rm(archive, { force: true });
    if (!existsSync(executable)) throw new Error(`Gradle extracted but ${executable} not found`);
  }

  const userHome = homePaths.gradleUserHome();
  await mkdir(userHome, { recursive: true });
  await writeFile(path.join(userHome, "gradle.properties"), USER_GRADLE_PROPERTIES);
  return { version, executable, userHome };
}
