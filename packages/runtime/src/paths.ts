import os from "node:os";
import path from "node:path";

/** Root folder for everything PlugForge downloads or creates at runtime (JDK, Paper, test servers). */
export function plugforgeHome(): string {
  if (process.env.PLUGFORGE_HOME) return path.resolve(process.env.PLUGFORGE_HOME);
  switch (process.platform) {
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "PlugForge");
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "PlugForge");
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "plugforge");
  }
}

export const homePaths = {
  jdk: () => path.join(plugforgeHome(), "jdk"),
  paper: () => path.join(plugforgeHome(), "paper"),
  servers: () => path.join(plugforgeHome(), "servers"),
  downloads: () => path.join(plugforgeHome(), "downloads"),
  config: () => path.join(plugforgeHome(), "config.json"),
};
