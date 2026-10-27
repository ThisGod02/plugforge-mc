import { existsSync } from "node:fs";
import path from "node:path";
import { checkProject, formatCheckResult } from "@plugforge/bench";
import {
  LlmGateway,
  RunLog,
  ScriptedModel,
  isEmptyDir,
  llmConfigPath,
  loadLlmConfig,
  loadSpec,
  resolveApiKey,
  runAgent,
  storeApiKey,
  type LlmCall,
} from "@plugforge/core";
import type { GradleInstall, JavaRuntime, Log } from "@plugforge/runtime";

export interface RunCommandOptions {
  specFile: string;
  out?: string;
  tests?: string;
  scripted?: string;
  maxFix?: number;
  java: JavaRuntime;
  gradle: GradleInstall;
  paperApi: string;
  pluginApiVersion: string;
  log: Log;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** `plugforge run`: spec.json (+ fixed tests) → plugin project brought to green L0+L1 by the agent. */
export async function runCommand(o: RunCommandOptions): Promise<boolean> {
  const specFile = path.resolve(o.specFile);
  const spec = await loadSpec(specFile);
  const defaultTests = path.join(path.dirname(specFile), "tests");
  const testsDir = o.tests ? path.resolve(o.tests) : existsSync(defaultTests) ? defaultTests : undefined;
  const runLog = await RunLog.create();
  const projectDir = path.resolve(o.out ?? path.join("out", `${spec.name}-${runLog.id}`));
  if (!(await isEmptyDir(projectDir))) throw new Error(`output directory is not empty: ${projectDir}`);

  const config = await loadLlmConfig();
  const onCall = async (call: LlmCall) => {
    await runLog.llmCall(call);
    const u = call.usage;
    o.log(
      `  llm #${call.seq} ${call.label} [${call.model}] ` +
        (call.error ? `FAILED: ${call.error}` : `${u?.promptTokens}→${u?.completionTokens} tok, ${usd(call.costUsd)}, ${(call.durationMs / 1000).toFixed(1)}s`),
    );
  };
  let gateway: LlmGateway;
  let scripted: ScriptedModel | undefined;
  if (o.scripted) {
    scripted = await ScriptedModel.load(path.resolve(o.scripted));
    gateway = new LlmGateway(config, async () => scripted!, onCall);
    o.log(`LLM: scripted replies from ${o.scripted}`);
  } else {
    gateway = LlmGateway.http(config, onCall);
    o.log(`LLM: ${Object.entries(config.routing).map(([r, p]) => `${r}=${config.profiles[p]!.model}`).join(", ")}; budget $${config.budget.maxCostUsdPerTask}`);
  }
  o.log(`run ${runLog.id}: ${spec.name}, ${spec.acceptance.length} acceptance criteria, tests: ${testsDir ?? "template only"}`);

  const result = await runAgent({
    spec,
    testsDir,
    projectDir,
    gateway,
    runLog,
    log: o.log,
    paperApi: o.paperApi,
    pluginApiVersion: o.pluginApiVersion,
    maxFixIterations: o.maxFix,
    check: (dir) => checkProject({ projectDir: dir, java: o.java, gradle: o.gradle, pluginApiVersion: o.pluginApiVersion, log: o.log }),
  });

  if (result.check) console.log(`\n${formatCheckResult(result.check)}`);
  const t = gateway.totals;
  console.log(
    [
      "",
      `=== ${result.status.toUpperCase()} ${result.reason ? `— ${result.reason}` : ""}`,
      `project      ${projectDir}`,
      `fix rounds   ${result.fixIterations}`,
      `llm calls    ${t.calls}, ${t.promptTokens} prompt (${t.cacheHitTokens} cached) + ${t.completionTokens} completion tokens, ${usd(t.costUsd)}${scripted ? " (scripted, estimated)" : ""}`,
      `run log      ${runLog.dir}`,
      ...result.disputes.map((d) => `TEST DISPUTE ${d}`),
    ].join("\n"),
  );
  if (scripted && scripted.remaining > 0) o.log(`note: ${scripted.remaining} scripted replies were not used`);
  return result.status === "done";
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
