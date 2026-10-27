import { readTree, renderFiles } from "../workspace/files.ts";
import { baseVars, plannerSystemMessage, renderPrompt, type StageContext } from "./context.ts";
import { specLanguage } from "./reporter.ts";

/** File name of the manual in `dist/`, in the spec's language. */
export const manualFileName = (lang: "ru" | "en") => (lang === "ru" ? "ИНСТРУКЦИЯ.md" : "MANUAL.md");

/**
 * Manual: the full guide for the server owner and the players, written from the delivered code
 * (not only the spec), so numbers and rules match what the jar does.
 */
export async function writeManual(ctx: StageContext): Promise<string> {
  const lang = specLanguage(ctx.spec);
  const prompt = await renderPrompt("manual", {
    ...baseVars(ctx),
    name: ctx.spec.name,
    manualTitle: lang === "ru" ? "инструкция" : "manual",
    files: renderFiles(await readTree(ctx.projectDir, "src/main")),
  });
  const reply = await ctx.gateway.chat("report", [await plannerSystemMessage(ctx), { role: "user", content: prompt }], { label: "report.manual" });
  const text = reply.content
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/, "$1")
    .trim();
  if (!text.startsWith("#") || text.length < 500) throw new Error(`the manual came back unusable (${text.length} chars)`);
  return `${text}\n`;
}
