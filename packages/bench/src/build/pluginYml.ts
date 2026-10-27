import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { Diagnostic } from "./types.ts";

const FILE = "src/main/resources/plugin.yml";

function error(message: string, detail?: string): Diagnostic {
  return { stage: "validate", severity: "error", message, file: FILE, detail };
}

function warning(message: string): Diagnostic {
  return { stage: "validate", severity: "warning", message, file: FILE };
}

/**
 * Checks the processed plugin.yml and build output the way Paper would on load:
 * required keys, a main class that exists and isn't in a reserved package, sane commands.
 */
export async function validatePluginYml(projectDir: string, expectedApiVersion: string): Promise<Diagnostic[]> {
  const built = path.join(projectDir, "build", "resources", "main", "plugin.yml");
  if (!existsSync(built)) return [error("plugin.yml not found in build output (expected at src/main/resources/plugin.yml)")];

  let yml: Record<string, unknown>;
  try {
    const parsed: unknown = parse(await readFile(built, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [error("plugin.yml must be a YAML mapping")];
    yml = parsed as Record<string, unknown>;
  } catch (err) {
    return [error("plugin.yml is not valid YAML", (err as Error).message)];
  }

  const out: Diagnostic[] = [];
  const name = yml.name;
  if (typeof name !== "string" || !name) out.push(error("missing required key 'name'"));
  else if (!/^[A-Za-z0-9 _.-]+$/.test(name)) out.push(error(`invalid plugin name '${name}': only letters, digits, space, _ . - allowed`));

  const version = yml.version;
  if (version === undefined || version === null || version === "") out.push(error("missing required key 'version'"));
  else if (String(version).includes("${")) out.push(error(`version '${version}' was not expanded by Gradle processResources`));

  const main = yml.main;
  if (typeof main !== "string" || !main) {
    out.push(error("missing required key 'main'"));
  } else if (/^(org\.bukkit|io\.papermc|net\.minecraft|org\.spigotmc)\./.test(main)) {
    out.push(error(`main class '${main}' is in a package reserved by the server`));
  } else {
    const classFile = path.join(projectDir, "build", "classes", "java", "main", ...main.split(".")) + ".class";
    if (!existsSync(classFile)) out.push(error(`main class '${main}' does not exist in compiled sources`));
  }

  const apiVersion = yml["api-version"];
  if (apiVersion === undefined) out.push(warning(`missing 'api-version' (expected '${expectedApiVersion}'); Paper will treat the plugin as legacy`));
  else if (String(apiVersion) !== expectedApiVersion) out.push(warning(`api-version is '${apiVersion}', bench targets '${expectedApiVersion}'`));

  const commands = yml.commands;
  if (commands !== undefined && commands !== null) {
    if (typeof commands !== "object" || Array.isArray(commands)) out.push(error("'commands' must be a mapping of command name to settings"));
    else for (const cmd of Object.keys(commands)) if (/[\s:]/.test(cmd)) out.push(error(`invalid command name '${cmd}': no spaces or colons`));
  }

  const libs = path.join(projectDir, "build", "libs");
  const jars = existsSync(libs) ? (await readdir(libs)).filter((f) => f.endsWith(".jar")) : [];
  if (jars.length === 0) out.push({ stage: "validate", severity: "error", message: "no plugin jar in build/libs" });

  return out;
}
