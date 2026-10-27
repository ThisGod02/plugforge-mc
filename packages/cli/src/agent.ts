import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkProject, compileTests, formatCheckResult } from "@plugforge/bench";
import {
  LlmGateway,
  RunLog,
  ScriptedModel,
  clarify,
  isEmptyDir,
  llmConfigPath,
  loadLlmConfig,
  loadSpec,
  resolveApiKey,
  runAgent,
  storeApiKey,
  writeSpec,
  type Answer,
  type Delivery,
  type LlmCall,
  type LlmContext,
  type PluginSpec,
} from "@plugforge/core";
import type { GradleInstall, JavaRuntime, Log } from "@plugforge/runtime";
import { answerQuestions, ask, askApproval, interactive, renderSpec, type ScriptedAnswers } from "./prompt.ts";

/** Bench and logging shared by the agent commands. */
export interface AgentEnv {
  java: JavaRuntime;
  gradle: GradleInstall;
  paperApi: string;
  pluginApiVersion: string;
  minecraftVersion: string;
  log: Log;
}

/** Where projects go without --out: a visible folder per plugin, never inside this repository. */
export function defaultProjectDir(name: string): string {
  const root = path.join(os.homedir(), "PlugForge");
  for (let i = 1; ; i++) {
    const dir = path.join(root, i === 1 ? name : `${name}-${i}`);
    if (!existsSync(dir) || readdirSync(dir).length === 0) return dir;
  }
}

export interface RunCommandOptions extends AgentEnv {
  specFile: string;
  out?: string;
  tests?: string;
  scripted?: string;
  maxFix?: number;
}

export interface CreateCommandOptions extends AgentEnv {
  request?: string;
  out?: string;
  /** Approve the spec and take recommended answers without asking. */
  yes: boolean;
  /** JSON array of answers for the clarifying questions (see ScriptedAnswers). */
  answersFile?: string;
  scripted?: string;
  maxFix?: number;
}

interface Session {
  gateway: LlmGateway;
  runLog: RunLog;
  scripted?: ScriptedModel;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** `plugforge run`: spec.json (+ optional ready-made tests) → plugin project brought to green L0+L1 by the agent. */
export async function runCommand(o: RunCommandOptions): Promise<boolean> {
  const specFile = path.resolve(o.specFile);
  const spec = await loadSpec(specFile);
  const defaultTests = path.join(path.dirname(specFile), "tests");
  const testsDir = o.tests ? path.resolve(o.tests) : existsSync(defaultTests) ? defaultTests : undefined;
  const session = await openSession(o.scripted, o.log);
  o.log(`run ${session.runLog.id}: ${spec.name}, ${spec.acceptance.length} acceptance criteria, tests: ${testsDir ?? "written by TestWriter"}`);
  return execute(spec, session, o, { out: o.out, testsDir, maxFix: o.maxFix, intake: { specFile } });
}

/** `plugforge create`: text request → questions → spec → approval → tests → code → fixes. */
export async function createCommand(o: CreateCommandOptions): Promise<boolean> {
  const request = o.request?.trim() || (interactive() ? await ask("Describe the plugin you want: ") : "");
  if (!request) throw new Error('usage: create "<what the plugin should do>"');
  const scriptedAnswers = o.answersFile ? (JSON.parse(await readFile(path.resolve(o.answersFile), "utf8")) as ScriptedAnswers) : undefined;
  const session = await openSession(o.scripted, o.log);
  const ctx: LlmContext = { gateway: session.gateway, paperApi: o.paperApi, pluginApiVersion: o.pluginApiVersion, log: o.log };
  await session.runLog.event("INTAKE", { request });
  o.log(`run ${session.runLog.id}`);

  // CLARIFY: at most two rounds (PLAN.md §6.1).
  const answers: Answer[] = [];
  for (let round = 1; round <= 2; round++) {
    await session.runLog.event("CLARIFY", { round });
    const questions = await clarify(ctx, request, answers);
    if (questions.length === 0) {
      o.log(round === 1 ? "Clarifier: the request is clear enough, no questions" : "Clarifier: no more questions");
      break;
    }
    answers.push(...(await answerQuestions(questions, { scripted: scriptedAnswers, useDefaults: o.yes })));
  }

  // SPEC + SPEC_APPROVAL
  await session.runLog.event("SPEC");
  let spec = await writeSpec(ctx, { request, answers });
  const revisions: string[] = [];
  for (;;) {
    console.log(`\n${"-".repeat(72)}\n${renderSpec(spec)}\n${"-".repeat(72)}`);
    if (o.yes) {
      o.log("spec approved (--yes)");
      break;
    }
    if (!interactive()) throw new Error("the spec needs your approval: run in a terminal, or pass --yes");
    const decision = await askApproval(spec);
    if (decision.action === "approve") break;
    if (decision.action === "cancel") {
      await session.runLog.write({ status: "cancelled", intake: { request, answers, revisions }, spec, totals: session.gateway.totals });
      o.log(`cancelled; the draft spec is in ${session.runLog.dir}\\run.json`);
      return false;
    }
    if (revisions.length >= 5) throw new Error("too many revisions; edit spec.json by hand and use `plugforge run`");
    revisions.push(decision.feedback);
    await session.runLog.event("SPEC_REVISE", { feedback: decision.feedback });
    spec = await writeSpec(ctx, { request, answers, revise: { spec, feedback: decision.feedback } });
  }
  await session.runLog.event("SPEC_APPROVED");
  return execute(spec, session, o, { out: o.out, maxFix: o.maxFix, intake: { request, answers, revisions } });
}

async function openSession(scriptedFile: string | undefined, log: Log): Promise<Session> {
  const runLog = await RunLog.create();
  const config = await loadLlmConfig();
  const onCall = async (call: LlmCall) => {
    await runLog.llmCall(call);
    const u = call.usage;
    log(
      `  llm #${call.seq} ${call.label} [${call.model}] ` +
        (call.error ? `FAILED: ${call.error}` : `${u?.promptTokens}→${u?.completionTokens} tok, ${usd(call.costUsd)}, ${(call.durationMs / 1000).toFixed(1)}s`),
    );
  };
  if (scriptedFile) {
    const scripted = await ScriptedModel.load(path.resolve(scriptedFile));
    log(`LLM: scripted replies from ${scriptedFile}`);
    return { runLog, scripted, gateway: new LlmGateway(config, async () => scripted, onCall) };
  }
  log(`LLM: ${Object.entries(config.routing).map(([r, p]) => `${r}=${config.profiles[p]!.model}`).join(", ")}; budget $${config.budget.maxCostUsdPerTask}`);
  return { runLog, gateway: LlmGateway.http(config, onCall) };
}

/** Runs the orchestrator from an approved spec and prints the summary. */
async function execute(
  spec: PluginSpec,
  session: Session,
  env: AgentEnv,
  opts: { out?: string; testsDir?: string; maxFix?: number; intake?: Record<string, unknown> },
): Promise<boolean> {
  const { gateway, runLog, scripted } = session;
  const projectDir = opts.out ? path.resolve(opts.out) : defaultProjectDir(spec.name);
  if (!(await isEmptyDir(projectDir))) throw new Error(`output directory is not empty: ${projectDir}`);
  const bench = { java: env.java, gradle: env.gradle, log: env.log };

  const result = await runAgent({
    spec,
    testsDir: opts.testsDir,
    projectDir,
    gateway,
    runLog,
    log: env.log,
    paperApi: env.paperApi,
    pluginApiVersion: env.pluginApiVersion,
    minecraftVersion: env.minecraftVersion,
    maxFixIterations: opts.maxFix,
    intake: opts.intake,
    check: (dir) => checkProject({ ...bench, projectDir: dir, pluginApiVersion: env.pluginApiVersion }),
    compileTests: (dir) => compileTests({ ...bench, projectDir: dir }),
  });

  if (result.check) console.log(`\n${formatCheckResult(result.check)}`);
  const t = gateway.totals;
  const coverage = Object.entries(result.coverage ?? {}).map(([ac, tests]) => `${ac}: ${tests.length ? tests.join(", ") : "NO TESTS"}`);
  console.log(
    [
      "",
      `=== ${result.status.toUpperCase()} ${result.reason ? `— ${result.reason}` : ""}`,
      `project      ${projectDir}`,
      `fix rounds   ${result.fixIterations}`,
      `llm calls    ${t.calls}, ${t.promptTokens} prompt (${t.cacheHitTokens} cached) + ${t.completionTokens} completion tokens, ${usd(t.costUsd)}${scripted ? " (scripted, estimated)" : ""}`,
      `run log      ${runLog.dir}`,
      ...(coverage.length ? ["coverage", ...coverage.map((c) => `  ${c}`)] : []),
      ...result.disputes.map((d) => `TEST DISPUTE ${d}`),
    ].join("\n"),
  );
  if (result.delivery) printDelivery(result.delivery);
  else console.log("\nNo plugin jar was delivered: the checks are not green. The project and the run log show where it stopped.");
  if (scripted && scripted.remaining > 0) env.log(`note: ${scripted.remaining} scripted replies were not used`);
  return result.status === "done";
}

export function printDelivery(d: Delivery): void {
  console.log(
    [
      "",
      `PLUGIN   ${d.jar}`,
      "         copy it into your server's plugins/ folder and restart the server",
      `README   ${d.readme}`,
    ].join("\n"),
  );
}

/** Reads a line from the terminal without echoing it. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** `plugforge key set <ref>`: stores an API key encrypted for the current Windows user. */
export async function keySetCommand(ref: string | undefined, log: Log): Promise<void> {
  if (!ref) throw new Error("usage: key set <name>   (e.g. key set deepseek)");
  const key = await readSecret(`API key for '${ref}' (input hidden): `);
  if (!key) throw new Error("empty key, nothing stored");
  const file = await storeApiKey(ref, key);
  log(`stored '${ref}' in ${file}${process.platform === "win32" ? " (DPAPI-encrypted for this Windows user)" : ""}`);
}

/** `plugforge llm ping [route]`: one tiny request through the gateway to prove key, URL and model work. */
export async function llmPingCommand(route: string | undefined, log: Log): Promise<void> {
  const config = await loadLlmConfig();
  const r = (route ?? "code") as keyof typeof config.routing;
  if (!config.routing[r]) throw new Error(`unknown route '${route}'; routes: ${Object.keys(config.routing).join(", ")}`);
  const profile = config.profiles[config.routing[r]]!;
  log(`config: ${existsSync(llmConfigPath()) ? llmConfigPath() : "built-in defaults"}`);
  log(`route ${r} → profile ${config.routing[r]} (${profile.model} at ${profile.baseUrl}), key '${profile.apiKeyRef}': ${(await resolveApiKey(profile.apiKeyRef)) ? "found" : "missing"}`);
  const gateway = LlmGateway.http(config);
  const reply = await gateway.chat(r, [{ role: "user", content: "Reply with exactly: pong" }], { label: "ping" });
  log(`reply: ${JSON.stringify(reply.content.trim().slice(0, 80))}; ${reply.usage.promptTokens}→${reply.usage.completionTokens} tokens, ${usd(gateway.totals.costUsd)}`);
}
