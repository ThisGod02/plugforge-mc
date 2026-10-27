import { readFile } from "node:fs/promises";
import path from "node:path";
import { plugforgeHome } from "@plugforge/runtime";
import type { LlmConfig, LlmProfile, Pricing } from "./types.ts";

// https://api-docs.deepseek.com/quick_start/pricing (checked 2026-10-27): off-peak rates,
// doubled 01:00-04:00 and 06:00-10:00 UTC on weekdays.
const DEEPSEEK_PEAK: Pricing["peak"] = { multiplier: 2, utcHours: [[1, 4], [6, 10]] };
const FLASH_PRICING: Pricing = { inputCacheHit: 0.003, inputCacheMiss: 0.15, output: 0.6, peak: DEEPSEEK_PEAK };
const PRO_PRICING: Pricing = { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98, peak: DEEPSEEK_PEAK };

const deepseek = (model: string, thinking: boolean, pricing: Pricing): LlmProfile => ({
  baseUrl: "https://api.deepseek.com",
  model,
  apiKeyRef: "deepseek",
  extraBody: { thinking: { type: thinking ? "enabled" : "disabled" } },
  // Reasoning tokens count against max_tokens; 32k was too tight for TestWriter on 12-criterion specs.
  maxTokens: 64_000,
  pricing,
});

export const defaultLlmConfig: LlmConfig = {
  profiles: {
    flash: deepseek("deepseek-flash", false, FLASH_PRICING),
    "flash-think": deepseek("deepseek-flash", true, FLASH_PRICING),
    pro: deepseek("deepseek-v4-pro", true, PRO_PRICING),
  },
  routing: {
    clarify: "flash",
    spec: "flash-think",
    tests: "flash-think",
    test_review: "flash-think",
    plan: "flash",
    code: "flash",
    fix: "flash-think",
    fix_escalation: "pro",
    report: "flash-think",
  },
  budget: { maxCostUsdPerTask: 0.5 },
};

export const llmConfigPath = () => path.join(plugforgeHome(), "llm.json");

/** Defaults overlaid with `<PlugForge>/llm.json` (profiles are replaced whole, routing/budget per key). */
export async function loadLlmConfig(): Promise<LlmConfig> {
  let user: Partial<LlmConfig> = {};
  try {
    user = JSON.parse(await readFile(llmConfigPath(), "utf8")) as Partial<LlmConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${llmConfigPath()}: ${(err as Error).message}`);
  }
  const config: LlmConfig = {
    profiles: { ...defaultLlmConfig.profiles, ...user.profiles },
    routing: { ...defaultLlmConfig.routing, ...user.routing },
    budget: { ...defaultLlmConfig.budget, ...user.budget },
  };
  for (const [route, profile] of Object.entries(config.routing)) {
    if (!config.profiles[profile]) throw new Error(`llm.json: route '${route}' uses unknown profile '${profile}'`);
  }
  return config;
}
