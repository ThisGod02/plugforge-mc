import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkProject, compileTests, formatCheckResult, liveStage } from "@plugforge/bench";
import {
  LlmGateway,
  RunLog,
  ScriptedModel,
  clarify,
  isEmptyDir,
  llmConfigPath,
  loadLlmConfig,
  loadSpec,
  planPhases,
  readPhaseHistory,
  renderPlan,
  resolveApiKey,
  runAgent,
  storeApiKey,
  writeSpec,
  type Answer,
  type Delivery,
  type LlmCall,
  type LlmContext,
  type PhaseOutcome,
  type PhasePlanItem,
  type PluginSpec,
} from "@plugforge/core";
import type { GradleInstall, JavaRuntime, Log, PaperInstall } from "@plugforge/runtime";
import { answerQuestions, ask, askApproval, interactive, renderSpec, renderSpecDiff, type ScriptedAnswers } from "./prompt.ts";

/** Bench and logging shared by the agent commands. */
export interface AgentEnv {
  java: JavaRuntime;
  gradle: GradleInstall;
  paper: PaperInstall;
  paperApi: string;
  pluginApiVersion: string;
  minecraftVersion: string;
  /** Write and play live scenarios (L2); off with --skip-live. */
  live: boolean;
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
  /** Ask for every phase spec too, not only for the build plan. */
  reviewSpecs?: boolean;
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

/** A delivered project that `improve` builds new phases on. */
interface BaseProject {
  dir: string;
  spec: PluginSpec;
  /** Phases already built, in order (one synthetic entry for single-phase projects). */
  history: PhaseOutcome[];
}

/** `plugforge create`: text request → questions → spec → approval → tests → code → fixes. */
export async function createCommand(o: CreateCommandOptions): Promise<boolean> {
  // Fail before the questions, not after the user has answered them and approved a spec.
  if (o.out && !(await isEmptyDir(o.out))) throw new Error(`output directory is not empty: ${path.resolve(o.out)}`);
  const request = o.request?.trim() || (interactive() ? await ask("Describe the plugin you want: ") : "");
  if (!request) throw new Error('usage: create "<what the plugin should do>"');
  return fromRequest(o, request);
}

/**
 * `plugforge improve <dir>`: a change request for a plugin the agent delivered. New phases are
 * built on top of it; its tests and scenarios stay as regression, and a failure rolls back to it.
 */
export async function improveCommand(o: CreateCommandOptions & { dir: string }): Promise<boolean> {
  const dir = path.resolve(o.dir);
  const specFile = path.join(dir, "spec.json");
  if (!existsSync(specFile) || !existsSync(path.join(dir, ".plugforge"))) {
    throw new Error(`${dir} is not a project PlugForge built (no spec.json or .plugforge/)`);
  }
  const spec = await loadSpec(specFile);
  const history: PhaseOutcome[] = (await readPhaseHistory(dir)) ?? [
    { title: spec.name, status: "done", fixIterations: 0, criteria: spec.acceptance.map((a) => a.id) },
  ];
  // Phase k writes <Main>Phase<k>Test.java; never reuse a number a test file already has.
  const testDir = path.join(dir, "src", "test", "java");
  const numbers = existsSync(testDir)
    ? readdirSync(testDir, { recursive: true }).map((f) => /Phase(\d+)Test\.java$/.exec(String(f))?.[1]).filter(Boolean).map(Number)
    : [];
  while (history.length < Math.max(0, ...numbers)) history.push({ title: `(phase ${history.length + 1})`, status: "done", fixIterations: 0, criteria: [] });
  const request = o.request?.trim() || (interactive() ? await ask(`What should change in ${spec.name}? `) : "");
  if (!request) throw new Error('usage: improve <project dir> "<what to add or change>"');
  return fromRequest(o, request, { dir, spec, history });
}

/** Questions → build plan (the one approval) → phase specs → build, for create and improve. */
async function fromRequest(o: CreateCommandOptions, userRequest: string, base?: BaseProject): Promise<boolean> {
  // The model sees what exists, so it plans and specifies only the change.
  const request = base
    ? [
        `Improve the existing plugin "${base.spec.name}" (${base.spec.description}).`,
        `It is already built and tested: commands ${base.spec.commands.map((c) => `/${c.name}`).join(", ") || "none"}; ` +
          `${base.spec.acceptance.length} acceptance criteria (AC1–AC${base.spec.acceptance.length}).`,
        "Ask, plan and specify only the new work below, on top of what exists; keep every existing feature working.",
        "",
        `Requested change: ${userRequest}`,
      ].join("\n")
    : userRequest;
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

  const revisions: string[] = [];
  const cancelled = async (what: string, draft: unknown) => {
    await session.runLog.write({ status: "cancelled", intake: { request, answers, revisions }, draft, totals: session.gateway.totals });
    o.log(`cancelled at ${what}; the draft is in ${path.join(session.runLog.dir, "run.json")}`);
    return false;
  };
  /** Shows a draft and loops until the user approves it, asks for changes, or cancels. */
  const approve = async <T,>(
    what: string,
    draft: T,
    show: (d: T) => string,
    revise: (d: T, feedback: string) => Promise<T>,
    isSpec = false,
    auto?: string,
  ): Promise<T | undefined> => {
    for (let d = draft; ; ) {
      console.log(`\n${"-".repeat(72)}\n${show(d)}\n${"-".repeat(72)}`);
      if (o.yes || auto) {
        o.log(`${what} approved (${o.yes ? "--yes" : auto})`);
        return d;
      }
      if (!interactive()) throw new Error(`the ${what} needs your approval: run in a terminal, or pass --yes`);
      const decision = await askApproval(isSpec ? (d as unknown as PluginSpec) : undefined, `the ${what}`);
      if (decision.action === "approve") return d;
      if (decision.action === "cancel") return undefined;
      if (revisions.length >= 8) throw new Error("too many revisions; edit spec.json by hand and use `plugforge run`");
      revisions.push(`${what}: ${decision.feedback}`);
      await session.runLog.event("REVISE", { what, feedback: decision.feedback });
      d = await revise(d, decision.feedback);
    }
  };

  // PHASES: big requests are built in steps, each on top of the previous one.
  await session.runLog.event("PHASES");
  const draftPlan = await planPhases(ctx, { request, answers });
  // A one-phase plan says nothing new: the spec approval right after is the real check.
  const plan = await approve(
    "build plan",
    draftPlan,
    (p) =>
      base
        ? `Improvement plan for ${base.spec.name}: ${p.length} new phase(s) on top of the ${base.history.length} built\n\n${renderPlan(p)}`
        : p.length === 1
          ? `Build plan: one phase — ${p[0]!.title}`
          : `Build plan: ${p.length} phases, each on top of the previous one\n\n${renderPlan(p)}`,
    (p, feedback) => planPhases(ctx, { request, answers, revise: { plan: p, feedback } }),
    false,
    draftPlan.length === 1 && !base ? "one phase" : undefined,
  );
  if (!plan) return cancelled("the build plan", undefined);
  // Improvements continue the numbering: built phases come first, already done.
  const fullPlan: PhasePlanItem[] = base ? [...base.history.map((h) => ({ title: h.title, goal: "Already built and tested." })), ...plan] : plan;
  const multi = fullPlan.length > 1;
  const phaseInfo = (index: number) => ({ index, plan: fullPlan });

  // SPEC + SPEC_APPROVAL. With several phases the approved plan is the one stop: phase specs are
  // shown and built without asking, so a long build runs unattended (--review-specs asks again).
  await session.runLog.event("SPEC");
  const title = (i: number) => (multi ? `Phase ${i + 1}/${fullPlan.length}: ${fullPlan[i]!.title}\n\n` : "");
  const autoSpec = multi && !o.reviewSpecs ? "the build plan is approved" : undefined;
  const first = base?.spec ?? await approve(
    multi ? "phase 1 spec" : "spec",
    await writeSpec(ctx, { request, answers, phase: phaseInfo(0) }),
    (s) => title(0) + renderSpec(s),
    (s, feedback) => writeSpec(ctx, { request, answers, phase: phaseInfo(0), revise: { spec: s, feedback } }),
    true,
    autoSpec,
  );
  if (!first) return cancelled("the spec", undefined);
  if (!base) await session.runLog.event("SPEC_APPROVED", { phase: 1 });

  const nextSpec = async (index: number, previous: PluginSpec): Promise<PluginSpec> => {
    const what = `phase ${index + 1} spec`;
    const spec = await approve(
      what,
      await writeSpec(ctx, { request, answers, phase: phaseInfo(index), previous }),
      (s) => `${title(index)}Changes on top of phase ${index}:\n\n${renderSpecDiff(previous, s)}`,
      (s, feedback) => writeSpec(ctx, { request, answers, phase: phaseInfo(index), previous, revise: { spec: s, feedback } }),
      true,
      autoSpec,
    );
    // Cancelling a later phase keeps what is built: the orchestrator rolls back and delivers it.
    if (!spec) throw new Error(`cancelled by the user before phase ${index + 1}`);
    await session.runLog.event("SPEC_APPROVED", { phase: index + 1 });
    return spec;
  };
  return execute(first, session, o, {
    out: base?.dir ?? o.out,
    existing: !!base,
    maxFix: o.maxFix,
    intake: { request: userRequest, ...(base ? { improves: base.dir } : {}), answers, revisions },
    phases: fullPlan,
    builtPhases: base?.history.length,
    builtOutcomes: base?.history,
    nextSpec: multi ? nextSpec : undefined,
  });
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
  opts: {
    out?: string;
    testsDir?: string;
    maxFix?: number;
    intake?: Record<string, unknown>;
    phases?: PhasePlanItem[];
    nextSpec?: (index: number, previous: PluginSpec) => Promise<PluginSpec>;
    /** `out` is a delivered project to improve, not a new folder. */
    existing?: boolean;
    builtPhases?: number;
    builtOutcomes?: PhaseOutcome[];
  },
): Promise<boolean> {
  const { gateway, runLog, scripted } = session;
  const projectDir = opts.out ? path.resolve(opts.out) : defaultProjectDir(spec.name);
  if (!opts.existing && !(await isEmptyDir(projectDir))) throw new Error(`output directory is not empty: ${projectDir}`);
  const bench = { java: env.java, gradle: env.gradle, log: env.log };
  let skipNoted = false;
  // L0 + L1, then L2 on a real server when the unit tests are green and the project has scenarios.
  const check = async (dir: string) => {
    const l1 = await checkProject({ ...bench, projectDir: dir, pluginApiVersion: env.pluginApiVersion });
    if (!env.live) return l1;
    // Scenario `covers` were validated when written; the spec grows between phases.
    const outcome = await liveStage(l1, { ...env, projectDir: dir });
    if (outcome.skipped && !skipNoted) {
      skipNoted = true;
      env.log(`warning: live tests skipped: ${outcome.skipped}`);
    }
    return outcome.result;
  };

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
    check,
    compileTests: (dir) => compileTests({ ...bench, projectDir: dir }),
    liveScenarios: env.live,
    phases: opts.phases,
    nextSpec: opts.nextSpec,
    builtPhases: opts.builtPhases,
    builtOutcomes: opts.builtOutcomes,
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
      ...(result.phases.length > 1
        ? [
            "phases",
            ...result.phases.map(
              (p, i) => `  ${i + 1}. ${p.status === "done" ? "done  " : p.status === "failed" ? "FAILED" : "—     "} ${p.title}${p.criteria.length ? ` (${p.criteria.join(", ")})` : ""}${p.reason ? ` — ${p.reason.split("\n")[0]}` : ""}`,
            ),
          ]
        : []),
      ...(coverage.length ? ["coverage", ...coverage.map((c) => `  ${c}`)] : []),
      ...result.disputes.map((d) => `TEST DISPUTE ${d}`),
    ].join("\n"),
  );
  if (result.status === "partial") console.log("\nPARTIAL  a later phase failed; the plugin below is the last green phase (see README → phases).");
  if (result.delivery) printDelivery(result.delivery);
  else console.log("\nNo plugin jar was delivered: the checks are not green. The project and the run log show where it stopped.");
  if (scripted && scripted.remaining > 0) env.log(`note: ${scripted.remaining} scripted replies were not used`);
  return result.status === "done";
}

export function printDelivery(d: Delivery): void {
  const high = d.untested.filter((u) => u.risk === "high");
  const shown = [...high, ...d.untested.filter((u) => u.risk === "medium")].slice(0, 5);
  console.log(
    [
      "",
      `PLUGIN   ${d.jar}`,
      "         copy it into your server's plugins/ folder and restart the server",
      `README   ${d.readme}`,
      ...(d.manual ? [`MANUAL   ${d.manual}`] : []),
      d.untested.length
        ? `UNTESTED ${d.untested.length} thing(s) the tests do not prove (${high.length} high risk), listed in the README:`
        : "UNTESTED nothing found",
      ...shown.map((u) => `         [${u.risk}] ${u.what}${u.where !== "spec" ? ` (${u.where})` : ""}`),
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
