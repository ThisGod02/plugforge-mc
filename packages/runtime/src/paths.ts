import os from "node:os";
import path from "node:path";

/** Root folder for everything PlugForge downloads or creates at runtime (JDK, Paper, test servers). */
export function plugforgeHome(): string {
  if (process.env.PLUGFORGE_HOME) return path.resolve(process.env.PLUGFORGE_HOME);
  switch (process.platform) {
    case "win32":
      // Not %LOCALAPPDATA%: when PlugForge runs under an MSIX-packaged app (e.g. a desktop
      // assistant), Windows silently redirects AppData writes into that package's private cache,
      // so a plain terminal would see a different, empty PlugForge folder.
      return path.join(os.homedir(), ".plugforge");
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "PlugForge");
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "plugforge");
  }
}

export const homePaths = {
  jdk: () => path.join(plugforgeHome(), "jdk"),
  paper: () => path.join(plugforgeHome(), "paper"),
  gradle: () => path.join(plugforgeHome(), "gradle"),
  /** GRADLE_USER_HOME shared by all builds, so dependencies are downloaded once. */
  gradleUserHome: () => path.join(plugforgeHome(), "gradle-home"),
  servers: () => path.join(plugforgeHome(), "servers"),
  downloads: () => path.join(plugforgeHome(), "downloads"),
  config: () => path.join(plugforgeHome(), "config.json"),
  /** One folder per agent run: prompts, replies, code per iteration, check results (PLAN.md §12). */
  runs: () => path.join(plugforgeHome(), "runs"),
};
