#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { TestServer, checkProject, connectBot, formatCheckResult } from "@plugforge/bench";
import {
  LlmGateway,
  deliver,
  loadLlmConfig,
  loadSpec,
  readTree,
  reviewCoverage,
  scaffoldPlugin,
  specGaps,
  specLanguage,
  testCoverage,
  type UntestedItem,
} from "@plugforge/core";
import {
  benchVersions,
  ensureGradle,
  ensureJava,
  ensurePaper,
  loadSettings,
  plugforgeHome,
  saveSettings,
  type Log,
} from "@plugforge/runtime";
import { createCommand, keySetCommand, llmPingCommand, printDelivery, runCommand } from "./agent.ts";
import { runSelftest } from "./selftest.ts";

const started = Date.now();
const log: Log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

const USAGE = `Usage: plugforge <command> [options]

Commands:
  setup                 Download/verify Java, Gradle and Paper for the test bench
  smoke                 Start a test server, join with a bot, chat, stop
  new <dir>             Create a plugin project from the template (--name, --package, --description)
  check <dir>           L0 build + plugin.yml validation + L1 MockBukkit tests (--json, --verbose);
                        on an agent project also refreshes dist/ and README (--audit re-runs the
                        untested-behaviour review with the model)
  selftest              Run the bench fixtures and compare with expected results (--only, --keep, --verbose)
  create "<request>"    Agent from a text request: questions → spec (you approve it) → tests → code → fixes
                        (--out <dir>, --yes to take recommended answers and approve, --answers <file.json>,
                         --max-fix <n> [8], --scripted <replies.json> to replay canned LLM answers)
  run <spec.json>       Agent from a ready spec: tests (ready-made or TestWriter) → code → fixes
                        (--out <dir>, --tests <dir> [default: tests/ next to the spec, else TestWriter],
                         --max-fix <n> [8], --scripted <replies.json>)
  key set <name>        Store an API key, e.g. "key set deepseek" (encrypted with Windows DPAPI)
  llm ping [route]      Send one tiny request through the LLM gateway (routes: plan, code, fix, fix_escalation)

Options:
  --accept-eula         Accept the Minecraft EULA (https://aka.ms/MinecraftEULA) and remember it
  --keep                Keep the server/project folder after the run (smoke, selftest)
`;

async function setup() {
  const versions = benchVersions();
  log(`PlugForge home: ${plugforgeHome()}`);
  const java = await ensureJava(versions.java.minFeature, log);
  log(`Java ${java.feature} (${java.source}): ${java.executable}`);
  const gradle = await ensureGradle(versions, log);
  log(`Gradle ${gradle.version}: ${gradle.executable}`);
  const paper = await ensurePaper(versions, java, log);
  log(`Paper ready: ${paper.jar}`);
  return { versions, java, gradle, paper };
}

async function newProject(dir: string | undefined, opts: { name?: string; packageName?: string; description?: string }) {
  if (!dir || !opts.name || !opts.packageName) throw new Error("usage: new <dir> --name <PluginName> --package <java.package>");
  const target = path.resolve(dir);
  await scaffoldPlugin(target, { name: opts.name, packageName: opts.packageName, description: opts.description });
  log(`created ${opts.name} in ${target}`);
}

async function check(dir: string | undefined, opts: { json: boolean; verbose: boolean; audit: boolean }) {
  if (!dir) throw new Error("usage: check <dir>");
  const { versions, java, gradle } = await setup();
  const result = await checkProject({
    projectDir: path.resolve(dir),
    java,
    gradle,
    pluginApiVersion: versions.pluginApiVersion,
    log,
    verbose: opts.verbose,
  });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatCheckResult(result));
  // Agent-made projects carry spec.json: a green check refreshes dist/ and README.md.
  const specFile = path.join(path.resolve(dir), "spec.json");
  if (result.ok && existsSync(specFile)) {
    const projectDir = path.resolve(dir);
    const spec = await loadSpec(specFile);
    const tests = await readTree(projectDir, "src/test");
    let untested: UntestedItem[] | undefined;
    if (opts.audit) {
      // Re-run the Reporter (one model call) instead of reusing .plugforge/report.json.
      const gateway = LlmGateway.http(await loadLlmConfig());
      const ctx = { spec, projectDir, gateway, paperApi: versions.paperApi, pluginApiVersion: versions.pluginApiVersion, log };
      untested = [...specGaps(spec, specLanguage(spec)), ...(await reviewCoverage(ctx))];
      log(`audit: ${untested.length} thing(s) not covered by tests, $${gateway.totals.costUsd.toFixed(4)}`);
    }
    const delivery = await deliver(projectDir, spec, result, {
      paperVersion: versions.minecraft,
      coverage: testCoverage(spec, tests).byCriterion,
      untested,
    });
    if (!opts.json) printDelivery(delivery);
  }
  if (!result.ok) process.exitCode = 1;
}

async function requireEula(acceptFlag: boolean) {
  const settings = await loadSettings();
  if (settings.eulaAcceptedAt) return;
  if (!acceptFlag) {
    throw new Error(
      "The test server needs the Minecraft EULA (https://aka.ms/MinecraftEULA) to be accepted.\n" +
        "Read it, then re-run with --accept-eula (asked only once).",
    );
  }
  await saveSettings({ ...settings, eulaAcceptedAt: new Date().toISOString() });
  log("Minecraft EULA acceptance saved");
}

async function smoke(opts: { acceptEula: boolean; keep: boolean }) {
  await requireEula(opts.acceptEula);
  const { versions, java, paper } = await setup();

  const server = await TestServer.start({ java, paper, eulaAccepted: true, keepDir: opts.keep, log });
  log(`server ready on 127.0.0.1:${server.port}`);
  try {
    const username = "player1";
    const bot = await connectBot({ port: server.port, username, version: versions.minecraft });
    await server.waitForLine(new RegExp(`${username} joined the game`), 15_000);
    log(`bot ${username} spawned at ${bot.entity.position.floored()}`);

    const message = "hello from plugforge";
    const from = server.lines.length;
    bot.chat(message);
    const chatLine = await server.waitForLine(new RegExp(`<${username}> ${message}`), 10_000, from);
    log(`server saw chat: ${chatLine}`);

    const list = await server.command("list");
    if (!list.includes(username)) throw new Error(`RCON 'list' does not show ${username}: ${list}`);
    log(`RCON list: ${list}`);

    bot.quit();
    await server.waitForLine(new RegExp(`${username} left the game`), 10_000);
  } finally {
    await server.stop();
    log(opts.keep ? `server stopped, folder kept: ${server.dir}` : "server stopped, folder removed");
  }
  log("SMOKE OK");
}

function parseMaxFix(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!(Number.isInteger(n) && n >= 0)) throw new Error("--max-fix must be a whole number");
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "accept-eula": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      audit: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      name: { type: "string" },
      package: { type: "string" },
      description: { type: "string" },
      only: { type: "string" },
      out: { type: "string" },
      tests: { type: "string" },
      scripted: { type: "string" },
      "max-fix": { type: "string" },
      answers: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "setup":
      await setup();
      break;
    case "smoke":
      await smoke({ acceptEula: values["accept-eula"]!, keep: values.keep! });
      break;
    case "new":
      await newProject(positionals[1], { name: values.name, packageName: values.package, description: values.description });
      break;
    case "check":
      await check(positionals[1], { json: values.json!, verbose: values.verbose!, audit: values.audit! });
      break;
    case "selftest": {
      const { versions, java, gradle } = await setup();
      const ok = await runSelftest({
        java,
        gradle,
        pluginApiVersion: versions.pluginApiVersion,
        log,
        only: values.only,
        keep: values.keep,
        verbose: values.verbose,
      });
      if (!ok) process.exitCode = 1;
      break;
    }
    case "create": {
      const { versions, java, gradle } = await setup();
      const ok = await createCommand({
        request: positionals.slice(1).join(" "),
        out: values.out,
        yes: values.yes!,
        answersFile: values.answers,
        scripted: values.scripted,
        maxFix: parseMaxFix(values["max-fix"]),
        java,
        gradle,
        paperApi: versions.paperApi,
        pluginApiVersion: versions.pluginApiVersion,
        minecraftVersion: versions.minecraft,
        log,
      });
      if (!ok) process.exitCode = 1;
      break;
    }
    case "run": {
      if (!positionals[1]) throw new Error("usage: run <spec.json> [--out <dir>] [--tests <dir>] [--max-fix <n>] [--scripted <file>]");
      const maxFix = parseMaxFix(values["max-fix"]);
      const { versions, java, gradle } = await setup();
      const ok = await runCommand({
        specFile: positionals[1],
        out: values.out,
        tests: values.tests,
        scripted: values.scripted,
        maxFix,
        java,
        gradle,
        paperApi: versions.paperApi,
        pluginApiVersion: versions.pluginApiVersion,
        minecraftVersion: versions.minecraft,
        log,
      });
      if (!ok) process.exitCode = 1;
      break;
    }
    case "key":
      if (positionals[1] !== "set") throw new Error("usage: key set <name>");
      await keySetCommand(positionals[2], log);
      break;
    case "llm":
      if (positionals[1] !== "ping") throw new Error("usage: llm ping [route]");
      await llmPingCommand(positionals[2], log);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
