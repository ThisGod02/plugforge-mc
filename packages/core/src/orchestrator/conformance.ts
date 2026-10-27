import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Diagnostic } from "@plugforge/bench";
import { parse } from "yaml";
import type { PluginSpec } from "../spec/spec.ts";

const FILE = "src/main/resources/plugin.yml";

/** Checks plugin.yml against the spec: the parts tests cannot see (declared commands, permissions, main). */
export async function specConformance(projectDir: string, spec: PluginSpec): Promise<Diagnostic[]> {
  const err = (message: string): Diagnostic => ({ stage: "validate", severity: "error", message, file: FILE });
  let yml: Record<string, unknown>;
  try {
    yml = (parse(await readFile(path.join(projectDir, FILE), "utf8")) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return [err(`cannot read plugin.yml: ${(e as Error).message}`)];
  }

  const out: Diagnostic[] = [];
  const main = `${spec.package}.${spec.mainClass}`;
  if (yml.main !== main) out.push(err(`'main' must be ${main} (spec), found ${String(yml.main)}`));
  if (yml.name !== spec.name) out.push(err(`'name' must be ${spec.name} (spec), found ${String(yml.name)}`));

  const commands = (yml.commands ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const c of spec.commands) {
    const declared = commands[c.name];
    if (declared === undefined) {
      out.push(err(`command '${c.name}' from the spec is not declared under 'commands:'`));
      continue;
    }
    if (c.permission && declared?.permission !== c.permission) {
      out.push(err(`command '${c.name}' must declare 'permission: ${c.permission}' (spec)`));
    }
    if (c.checksPermission && declared?.permission) {
      out.push(err(`command '${c.name}' must not declare 'permission:'; the spec has the code check ${c.checksPermission} and send its own message`));
    }
  }
  const permissions = (yml.permissions ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const p of spec.permissions ?? []) {
    const declared = permissions[p.node];
    if (declared === undefined) out.push(err(`permission '${p.node}' from the spec is not declared under 'permissions:'`));
    else if (String(declared?.default ?? "op") !== p.default) out.push(err(`permission '${p.node}' must have 'default: ${p.default}' (spec)`));
  }
  return out;
}
