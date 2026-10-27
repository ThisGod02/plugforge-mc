import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface BenchVersions {
  minecraft: string;
  java: { minFeature: number };
  paper: { version: string; build: number; sha256: string; url: string };
  /** Maven version of io.papermc.paper:paper-api plugins compile against. */
  paperApi: string;
  /** Value for `api-version` in plugin.yml. */
  pluginApiVersion: string;
  gradle: { version: string; sha256: string; url: string };
  mineflayer: string;
  mockbukkit: { artifact: string; version: string };
  junit: string;
}

const versionsFile = fileURLToPath(new URL("../../../bench.versions.json", import.meta.url));

let cached: BenchVersions | undefined;

export function benchVersions(): BenchVersions {
  cached ??= JSON.parse(readFileSync(versionsFile, "utf8")) as BenchVersions;
  return cached;
}
