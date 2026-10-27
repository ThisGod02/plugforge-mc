import type { PluginSpec } from "../spec/spec.ts";
import { readTree, renderFiles } from "../workspace/files.ts";
import { baseVars, plannerSystemMessage, renderPrompt, renderTests, type StageContext } from "./context.ts";
import { extractJson } from "./protocol.ts";

export interface UntestedItem {
  what: string;
  /** Main source file, or "spec" for gaps found by comparing the spec with its criteria. */
  where: string;
  risk: "high" | "medium" | "low";
  source: "spec" | "review";
}

const MAX_REVIEW_ITEMS = 10;

/** "/realm vassal add <игрок>" → "/realm vassal add": the literal part before the first argument. */
function literal(variant: string): string {
  const words = variant.trim().split(/\s+/);
  const firstArg = words.findIndex((w) => /^[<[]/.test(w));
  return (firstArg < 0 ? words : words.slice(0, firstArg)).join(" ");
}

/**
 * Gaps visible without reading code: command forms (each `|` variant of `usage`) and config keys
 * that no acceptance criterion mentions. Criteria are what the tests are written from.
 */
export function specGaps(spec: PluginSpec, language: "ru" | "en"): UntestedItem[] {
  const criteria = spec.acceptance.map((a) => a.text.toLowerCase()).join("\n");
  // Forms are separated by " | "; a bare "|" belongs to an argument such as <да|нет>.
  const commands = spec.commands
    .flatMap((c) => (c.usage ?? `/${c.name}`).split(/\s+\|\s+/))
    .map((v) => literal(v))
    .filter((lit) => lit.startsWith("/") && !criteria.includes(lit.toLowerCase()));
  const settings = (spec.config ?? []).map((k) => k.key).filter((key) => !criteria.includes(key.toLowerCase()));
  // One row each, so a long list of small gaps does not bury the reviewer's findings.
  const out: UntestedItem[] = [];
  if (commands.length) {
    out.push({
      what: language === "ru" ? `Команды без критериев приёмки, их никто не проверял: ${commands.join(", ")}` : `Commands no acceptance criterion covers, so nothing tested them: ${commands.join(", ")}`,
      where: "spec",
      risk: "medium",
      source: "spec",
    });
  }
  if (settings.length) {
    out.push({
      what:
        language === "ru"
          ? `Настройки, которые тесты не меняют (проверены только значения по умолчанию): ${settings.join(", ")}`
          : `Settings the tests never change (only defaults are exercised): ${settings.join(", ")}`,
      where: "config.yml",
      risk: "low",
      source: "spec",
    });
  }
  return out;
}

function checkItems(raw: unknown): UntestedItem[] {
  const list = (raw as { untested?: unknown })?.untested;
  if (!Array.isArray(list)) throw new Error('expected {"untested": [...]}');
  return (list as { what?: unknown; where?: unknown; risk?: unknown }[])
    .filter((i) => typeof i?.what === "string" && i.what.trim())
    .slice(0, MAX_REVIEW_ITEMS)
    .map((i) => ({
      what: (i.what as string).trim(),
      where: typeof i.where === "string" && i.where.trim() ? i.where.trim() : "?",
      risk: i.risk === "high" || i.risk === "low" ? i.risk : "medium",
      source: "review" as const,
    }));
}

/** Reporter (PLAN.md §6.6), coverage part: one model call over spec, tests and code. */
export async function reviewCoverage(ctx: StageContext): Promise<UntestedItem[]> {
  const prompt = await renderPrompt("reporter", {
    ...baseVars(ctx),
    tests: await renderTests(ctx.projectDir),
    files: renderFiles(await readTree(ctx.projectDir, "src/main")),
  });
  const reply = await ctx.gateway.chat("report", [await plannerSystemMessage(ctx), { role: "user", content: prompt }], { json: true, label: "report.coverage" });
  return checkItems(extractJson(reply.content));
}

export const specLanguage = (spec: PluginSpec): "ru" | "en" =>
  /[Ѐ-ӿ]/.test(`${spec.description} ${Object.values(spec.messages ?? {}).join(" ")}`) ? "ru" : "en";
