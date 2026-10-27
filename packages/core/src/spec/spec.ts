import { readFile } from "node:fs/promises";
import { schemaErrors } from "./schema.ts";

export interface SpecCommand {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
  /** Declared in plugin.yml; Bukkit then rejects senders without it before the executor runs. */
  permission?: string;
  playerOnly?: boolean;
}

export interface SpecPermission {
  node: string;
  description?: string;
  default: "true" | "false" | "op" | "not op";
}

export interface SpecConfigKey {
  key: string;
  type: "string" | "int" | "double" | "boolean" | "string-list";
  default: unknown;
  description?: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

/** Plugin specification (PLAN.md §5), validated by spec/schema.ts. Covers commands, permissions, config and messages. */
export interface PluginSpec {
  name: string;
  package: string;
  mainClass: string;
  description: string;
  commands: SpecCommand[];
  permissions?: SpecPermission[];
  config?: SpecConfigKey[];
  /** Exact texts the plugin sends, by key. */
  messages?: Record<string, string>;
  acceptance: AcceptanceCriterion[];
  assumptions?: string[];
}

const RESERVED_PACKAGE = /^(org\.bukkit|io\.papermc|net\.minecraft|org\.spigotmc|com\.destroystokyo|net\.kyori|org\.mockbukkit)(\.|$)/;

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

/** JSON Schema (spec/schema.ts) plus the rules a schema cannot express. */
export function validateSpec(spec: unknown): string[] {
  const errors = schemaErrors(spec);
  if (errors.length) return errors;
  const s = spec as PluginSpec;
  if (RESERVED_PACKAGE.test(s.package)) errors.push(`package: '${s.package}' is reserved by the server or libraries`);
  for (const d of duplicates(s.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]))) errors.push(`commands: '${d}' is used twice`);
  for (const d of duplicates((s.permissions ?? []).map((p) => p.node))) errors.push(`permissions: '${d}' is declared twice`);
  for (const d of duplicates((s.config ?? []).map((c) => c.key))) errors.push(`config: '${d}' is declared twice`);
  for (const d of duplicates(s.acceptance.map((a) => a.id))) errors.push(`acceptance: id '${d}' is used twice`);
  const declared = new Set((s.permissions ?? []).map((p) => p.node));
  for (const c of s.commands) {
    if (c.permission && !declared.has(c.permission)) errors.push(`commands.${c.name}: permission '${c.permission}' is not in 'permissions'`);
  }
  return errors;
}

export async function loadSpec(file: string): Promise<PluginSpec> {
  const spec = JSON.parse(await readFile(file, "utf8")) as PluginSpec;
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(`invalid spec ${file}:\n  ${errors.join("\n  ")}`);
  return spec;
}
