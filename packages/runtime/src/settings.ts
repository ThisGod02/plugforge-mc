import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { homePaths } from "./paths.ts";

export interface Settings {
  /** ISO timestamp of when the user accepted the Minecraft EULA (https://aka.ms/MinecraftEULA). */
  eulaAcceptedAt?: string;
}

export async function loadSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(homePaths.config(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(path.dirname(homePaths.config()), { recursive: true });
  await writeFile(homePaths.config(), JSON.stringify(settings, null, 2));
}
