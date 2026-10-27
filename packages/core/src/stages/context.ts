import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Log } from "@plugforge/runtime";
import type { LlmGateway } from "../llm/gateway.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { AcceptanceCriterion, PluginSpec } from "../spec/spec.ts";
import { readTree, renderFiles } from "../workspace/files.ts";

const promptsDir = fileURLToPath(new URL("../../prompts/", import.meta.url));

/** What every model-calling stage needs, including the ones that run before a spec exists. */
export interface LlmContext {
  gateway: LlmGateway;
  paperApi: string;
  pluginApiVersion: string;
  log: Log;
}

/** The build phase a stage works in; absent for a single-phase build. */
export interface PhaseScope {
  /** 0-based. */
  index: number;
  total: number;
  title: string;
  goal: string;
  /** Criteria this phase adds; earlier ones already have tests and code. */
  newCriteria: AcceptanceCriterion[];
}

/** Stages that work on a project: the spec and the project on disk on top of the model. */
export interface StageContext extends LlmContext {
  /** Cumulative spec (the whole plugin up to the current phase). */
  spec: PluginSpec;
  projectDir: string;
  phase?: PhaseScope;
}

/** True when the phase builds on code from earlier phases. */
export const extending = (ctx: StageContext) => (ctx.phase?.index ?? 0) > 0;

/** "AC9 text" lines of what the current phase adds (or the whole spec). */
export function renderCriteria(ctx: StageContext): string {
  return (ctx.phase?.newCriteria ?? ctx.spec.acceptance).map((a) => `- ${a.id}: ${a.text}`).join("\n");
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

/** A prompt fragment inserted verbatim (e.g. the MockBukkit cheat sheet, which contains Java braces). */
export function rawPrompt(name: string): Promise<string> {
  return readFile(`${promptsDir}${name}.md`, "utf8");
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

/** System prompt for code-writing stages (Coder, Fixer): tests are fixed. */
export async function systemMessage(ctx: StageContext): Promise<ChatMessage> {
  return { role: "system", content: await renderPrompt("system", baseVars(ctx)) };
}

/** System prompt for the stages that shape the task (Clarifier, SpecWriter, TestWriter, TestReview). */
export async function plannerSystemMessage(ctx: LlmContext): Promise<ChatMessage> {
  return { role: "system", content: await renderPrompt("system-planner", { paperApi: ctx.paperApi, pluginApiVersion: ctx.pluginApiVersion }) };
}

export async function renderTests(projectDir: string): Promise<string> {
  const tests = await readTree(projectDir, "src/test");
  return tests.size ? renderFiles(tests) : "(no tests)";
}
