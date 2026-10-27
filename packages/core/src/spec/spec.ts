import { readFile } from "node:fs/promises";

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

/** Plugin specification (PLAN.md §5). M2 covers commands, permissions, config and messages. */
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
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CLASS = /^[A-Z][A-Za-z0-9_]*$/;
const COMMAND = /^[a-z0-9_-]+$/;

/** Structural checks; JSON Schema validation comes with SpecWriter in M3. */
export function validateSpec(spec: PluginSpec): string[] {
  const errors: string[] = [];
  if (!NAME.test(spec.name ?? "")) errors.push(`name: invalid plugin name '${spec.name}'`);
  if (!PACKAGE.test(spec.package ?? "")) errors.push(`package: invalid Java package '${spec.package}'`);
  if (!CLASS.test(spec.mainClass ?? "")) errors.push(`mainClass: invalid class name '${spec.mainClass}'`);
  if (!spec.description) errors.push("description: required");
  if (!Array.isArray(spec.commands)) errors.push("commands: must be an array");
  else {
    const seen = new Set<string>();
    for (const c of spec.commands) {
      if (!COMMAND.test(c.name ?? "")) errors.push(`commands: invalid command name '${c.name}'`);
      if (seen.has(c.name)) errors.push(`commands: duplicate '${c.name}'`);
      seen.add(c.name);
    }
  }
  if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0) errors.push("acceptance: at least one criterion required");
  else {
    const ids = new Set<string>();
    for (const a of spec.acceptance) {
      if (!a.id || !a.text) errors.push("acceptance: every criterion needs id and text");
      if (ids.has(a.id)) errors.push(`acceptance: duplicate id '${a.id}'`);
      ids.add(a.id);
    }
  }
  return errors;
}

export async function loadSpec(file: string): Promise<PluginSpec> {
  const spec = JSON.parse(await readFile(file, "utf8")) as PluginSpec;
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(`invalid spec ${file}:\n  ${errors.join("\n  ")}`);
  return spec;
}
