import { editablePath, readTree, renderFiles, writeProjectFile } from "../workspace/files.ts";
import type { ChatMessage } from "../llm/types.ts";
import { baseVars, extending, mainClassPath, renderCriteria, renderPrompt, renderTests, systemMessage, type StageContext } from "./context.ts";
import { extractCodeBlock, extractJson } from "./protocol.ts";

export interface PlannedFile {
  path: string;
  purpose: string;
}

const PLUGIN_YML = "src/main/resources/plugin.yml";
const CONFIG_YML = "src/main/resources/config.yml";

/**
 * Files the plan must contain. A new plugin needs its main class and descriptors; a later phase
 * must touch plugin.yml / config.yml only when the spec names commands, permissions or keys
 * they do not contain yet.
 */
function requiredFiles(ctx: StageContext, current: Map<string, string>): string[] {
  const s = ctx.spec;
  if (!extending(ctx)) return [mainClassPath(s), PLUGIN_YML, ...(s.config?.length ? [CONFIG_YML] : [])];
  const out: string[] = [];
  const yml = current.get(PLUGIN_YML) ?? "";
  const declared = (name: string) => new RegExp(`^\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?\\s*:`, "m").test(yml);
  if (s.commands.some((c) => !declared(c.name)) || (s.permissions ?? []).some((p) => !declared(p.node))) out.push(PLUGIN_YML);
  const config = current.get(CONFIG_YML) ?? "";
  if ((s.config ?? []).some((k) => !config.includes(`${k.key.split(".").pop()}:`))) out.push(CONFIG_YML);
  return out;
}

function checkPlan(raw: unknown, required: string[]): PlannedFile[] {
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
  for (const r of required) if (!seen.has(r)) throw new Error(`the plan must include ${r}`);
  return plan;
}

/** Asks for the file list; one retry with the validation error when the answer is unusable. */
async function planFiles(ctx: StageContext, tests: string, current: Map<string, string>): Promise<PlannedFile[]> {
  const required = requiredFiles(ctx, current);
  const scope = extending(ctx)
    ? `\n## Scope: phase ${ctx.phase!.index + 1} of ${ctx.phase!.total} — ${ctx.phase!.title}\n${ctx.phase!.goal}\n\n` +
      `The current code passes every test of the earlier phases; keep it working. This phase adds:\n${renderCriteria(ctx)}\n\n` +
      "List only the files to create, and the existing files you must rewrite for this phase.\n"
    : "";
  const messages: ChatMessage[] = [
    await systemMessage(ctx),
    {
      role: "user",
      content: await renderPrompt("coder-plan", {
        ...baseVars(ctx),
        tests,
        current: renderFiles(current),
        scope,
        required: required.length ? `Always include: ${required.map((r) => `\`${r}\``).join(", ")}.` : "",
      }),
    },
  ];
  const label = `coder.plan${extending(ctx) ? `.phase${ctx.phase!.index + 1}` : ""}`;
  for (let attempt = 1; ; attempt++) {
    const reply = await ctx.gateway.chat("plan", messages, { json: true, label });
    try {
      return checkPlan(extractJson(reply.content), required);
    } catch (err) {
      if (attempt >= 2) throw new Error(`Coder could not produce a usable file plan: ${(err as Error).message}`);
      messages.push({ role: "assistant", content: reply.content }, { role: "user", content: `Invalid plan: ${(err as Error).message}. Answer with corrected JSON only.` });
    }
  }
}

/**
 * Coder (PLAN.md §6.4): a file plan first, then each file in its own call with the whole current
 * code in context (the scaffold, earlier phases, files written so far). Cheap models make fewer
 * cross-file mistakes this way; in later phases it extends the code instead of starting over.
 */
export async function writeProject(ctx: StageContext): Promise<PlannedFile[]> {
  const tests = await renderTests(ctx.projectDir);
  const plan = await planFiles(ctx, tests, await readTree(ctx.projectDir, "src/main"));
  ctx.log(`Coder: plan has ${plan.length} files: ${plan.map((f) => f.path.split("/").pop()).join(", ")}`);
  const planText = plan.map((f) => `- ${f.path}: ${f.purpose}`).join("\n");

  for (const file of plan) {
    const current = await readTree(ctx.projectDir, "src/main");
    const exists = current.has(file.path);
    const prompt = await renderPrompt("coder-file", {
      ...baseVars(ctx),
      tests,
      plan: planText,
      written: renderFiles(current),
      path: file.path,
      purpose: file.purpose,
      // The scaffold's plugin.yml and main class are in the current code; rewriting from them
      // keeps required keys (name, version, main, api-version) that models tend to drop.
      existing: exists ? "\nThis file exists (see the current code above). Write its complete new version, keeping everything it does that is still needed.\n" : "",
    });
    const reply = await ctx.gateway.chat("code", [await systemMessage(ctx), { role: "user", content: prompt }], { label: `coder.file ${file.path}` });
    const content = extractCodeBlock(reply.content);
    if (!content) throw new Error(`Coder returned an empty ${file.path}`);
    await writeProjectFile(ctx.projectDir, file.path, content);
    ctx.log(`Coder: ${exists ? "rewrote" : "wrote"} ${file.path} (${content.split("\n").length} lines)`);
  }
  return plan;
}
