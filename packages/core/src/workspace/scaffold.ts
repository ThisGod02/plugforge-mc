import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchVersions } from "@plugforge/runtime";

export interface ScaffoldOptions {
  /** Plugin name as it appears in plugin.yml, e.g. "SimpleCasino". */
  name: string;
  /** Java package, e.g. "dev.plugforge.simplecasino". */
  packageName: string;
  /** Main class name; derived from `name` when omitted. */
  mainClass?: string;
  description?: string;
}

const templateDir = fileURLToPath(new URL("../../../../java/templates/paper-plugin", import.meta.url));

const NAME = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CLASS = /^[A-Z][A-Za-z0-9_]*$/;

function toClassName(name: string): string {
  const pascal = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
  return pascal.endsWith("Plugin") ? pascal : `${pascal}Plugin`;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
}

/** Creates a new plugin project in `targetDir` from the Paper plugin template. */
export async function scaffoldPlugin(targetDir: string, opts: ScaffoldOptions): Promise<void> {
  const mainClass = opts.mainClass ?? toClassName(opts.name);
  if (!NAME.test(opts.name)) throw new Error(`invalid plugin name: ${opts.name}`);
  if (!PACKAGE.test(opts.packageName)) throw new Error(`invalid Java package: ${opts.packageName}`);
  if (!CLASS.test(mainClass)) throw new Error(`invalid main class name: ${mainClass}`);
  if (existsSync(targetDir) && (await readdir(targetDir)).length > 0) {
    throw new Error(`target directory is not empty: ${targetDir}`);
  }

  const v = benchVersions();
  const tokens: Record<string, string> = {
    name: opts.name,
    package: opts.packageName,
    mainClass,
    // A JSON string is a valid YAML double-quoted scalar, so any description is safe in plugin.yml.
    descriptionYaml: JSON.stringify(opts.description ?? `${opts.name} plugin`),
    paperApi: v.paperApi,
    pluginApiVersion: v.pluginApiVersion,
    mockbukkitArtifact: v.mockbukkit.artifact,
    mockbukkitVersion: v.mockbukkit.version,
    junit: v.junit,
  };

  for (const rel of await listFiles(templateDir)) {
    const destRel = rel
      .split(path.sep)
      .flatMap((part) => (part === "__package__" ? opts.packageName.split(".") : [part.replaceAll("__MainClass__", mainClass)]))
      .join(path.sep);
    const content = (await readFile(path.join(templateDir, rel), "utf8")).replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = tokens[key];
      if (value === undefined) throw new Error(`template ${rel} uses unknown token ${match}`);
      return value;
    });
    const dest = path.join(targetDir, destRel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
}
