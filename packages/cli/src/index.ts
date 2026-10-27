#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { TestServer, connectBot } from "@plugforge/bench";
import {
  benchVersions,
  ensureJava,
  ensurePaper,
  loadSettings,
  plugforgeHome,
  saveSettings,
  type Log,
} from "@plugforge/runtime";

const started = Date.now();
const log: Log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

const USAGE = `Usage: plugforge <command> [options]

Commands:
  setup                 Download/verify Java and Paper for the test bench
  smoke                 Start a test server, join with a bot, chat, stop

Options:
  --accept-eula         Accept the Minecraft EULA (https://aka.ms/MinecraftEULA) and remember it
  --keep                Keep the server folder after the run (smoke)
`;

async function setup() {
  const versions = benchVersions();
  log(`PlugForge home: ${plugforgeHome()}`);
  const java = await ensureJava(versions.java.minFeature, log);
  log(`Java ${java.feature} (${java.source}): ${java.executable}`);
  const paper = await ensurePaper(versions, java, log);
  log(`Paper ready: ${paper.jar}`);
  return { versions, java, paper };
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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "accept-eula": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
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
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
