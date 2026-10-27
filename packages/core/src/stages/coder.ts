import { editablePath, fenceFor, readTree, renderFiles, writeProjectFile } from "../workspace/files.ts";
import type { ChatMessage } from "../llm/types.ts";
import { baseVars, mainClassPath, renderPrompt, renderTests, systemMessage, type StageContext } from "./context.ts";
import { extractCodeBlock, extractJson } from "./protocol.ts";

export interface PlannedFile {
  path: string;
  purpose: string;
}

function checkPlan(raw: unknown, ctx: StageContext): PlannedFile[] {
  const files = (raw as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('expected {"files": [{"path", "purpose"}, ...]}');
  const plan: PlannedFile[] = [];
  const seen = new Set<string>();
  for (const f of files as { path?: unknown; purpose?: unknown }[]) {
    if (typeof f?.path !== "string") throw new Error("every file needs a string 'path'");
    const rel = editablePath(f.path);
    if (seen.has(rel)) continue;
    seen.add(rel);
    plan.push({ path: rel, purpose: typeof f.purpose === "string" ? f.purpose : "" });
  }
  for (const required of [mainClassPath(ctx.spec), "src/main/resources/plugin.yml"]) {
    if (!seen.has(required)) throw new Error(`the plan must include ${required}`);
  }
  if (ctx.spec.config?.length && !seen.has("src/main/resources/config.yml")) throw new Error("the plan must include src/main/resources/config.yml");
  return plan;
}

/** Asks for the file list; one retry with the validation error when the answer is unusable. */
async function planFiles(ctx: StageContext, tests: string): Promise<PlannedFile[]> {
  const messages: ChatMessage[] = [
    await systemMessage(ctx),
    { role: "user", content: await renderPrompt("coder-plan", { ...baseVars(ctx), tests }) },
  ];
  for (let attempt = 1; ; attempt++) {
    const reply = await ctx.gateway.chat("plan", messages, { json: true, label: "coder.plan" });
    try {
      return checkPlan(extractJson(reply.content), ctx);
    } catch (err) {
      if (attempt >= 2) throw new Error(`Coder could not produce a usable file plan: ${(err as Error).message}`);
      messages.push({ role: "assistant", content: reply.content }, { role: "user", content: `Invalid plan: ${(err as Error).message}. Answer with corrected JSON only.` });
    }
  }
}

/**
 * Coder (PLAN.md §6.4): a file plan first, then each file in its own call with the files
 * written so far in context. Cheap models make fewer cross-file mistakes this way.
 */
export async function writeProject(ctx: StageContext): Promise<PlannedFile[]> {
  const tests = await renderTests(ctx.projectDir);
  const plan = await planFiles(ctx, tests);
  ctx.log(`Coder: plan has ${plan.length} files: ${plan.map((f) => f.path.split("/").pop()).join(", ")}`);
  const planText = plan.map((f) => `- ${f.path}: ${f.purpose}`).join("\n");

  // The scaffold already holds plugin.yml and the main class; showing them keeps required keys
  // (name, version, main, api-version) that a model writing from scratch tends to drop.
  const template = await readTree(ctx.projectDir, "src/main");
  const written = new Map<string, string>();
  for (const file of plan) {
    const base = template.get(file.path);
    const prompt = await renderPrompt("coder-file", {
      existing: base
        ? `\nThe project template already has this file; keep everything it declares and extend it:\n\`\`\`${fenceFor(file.path)}\n${base.trimEnd()}\n\`\`\`\n`
        : "",
      ...baseVars(ctx),
      tests,
      plan: planText,
      written: written.size ? renderFiles(written) : "(none yet)",
      path: file.path,
      purpose: file.purpose,
    });
    const reply = await ctx.gateway.chat("code", [await systemMessage(ctx), { role: "user", content: prompt }], { label: `coder.file ${file.path}` });
    const content = extractCodeBlock(reply.content);
    if (!content) throw new Error(`Coder returned an empty ${file.path}`);
    await writeProjectFile(ctx.projectDir, file.path, content);
    written.set(file.path, content);
    ctx.log(`Coder: wrote ${file.path} (${content.split("\n").length} lines)`);
  }

  // Template files the plan did not mention (e.g. a placeholder main class) stay as scaffolded.
  const leftovers = [...(await readTree(ctx.projectDir, "src/main")).keys()].filter((p) => !written.has(p));
  if (leftovers.length) ctx.log(`Coder: kept template files ${leftovers.join(", ")}`);
  return plan;
}
