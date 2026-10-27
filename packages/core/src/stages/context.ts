import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Log } from "@plugforge/runtime";
import type { LlmGateway } from "../llm/gateway.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { PluginSpec } from "../spec/spec.ts";
import { readTree, renderFiles } from "../workspace/files.ts";

const promptsDir = fileURLToPath(new URL("../../prompts/", import.meta.url));

/** What every stage needs: the task, the project on disk and a model. */
export interface StageContext {
  spec: PluginSpec;
  projectDir: string;
  gateway: LlmGateway;
  paperApi: string;
  pluginApiVersion: string;
  log: Log;
}

export const mainClassPath = (spec: PluginSpec) => `src/main/java/${spec.package.replaceAll(".", "/")}/${spec.mainClass}.java`;

export async function renderPrompt(name: string, vars: Record<string, string>): Promise<string> {
  const template = await readFile(`${promptsDir}${name}.md`, "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`prompt ${name} uses unknown variable ${match}`);
    return value;
  });
}

/** Variables shared by all prompts. */
export function baseVars(ctx: StageContext): Record<string, string> {
  return {
    paperApi: ctx.paperApi,
    pluginApiVersion: ctx.pluginApiVersion,
    package: ctx.spec.package,
    mainClass: ctx.spec.mainClass,
    mainClassPath: mainClassPath(ctx.spec),
    spec: JSON.stringify(ctx.spec, null, 2),
  };
}

export async function systemMessage(ctx: StageContext): Promise<ChatMessage> {
  return { role: "system", content: await renderPrompt("system", baseVars(ctx)) };
}

export async function renderTests(projectDir: string): Promise<string> {
  const tests = await readTree(projectDir, "src/test");
  return tests.size ? renderFiles(tests) : "(no tests)";
}
