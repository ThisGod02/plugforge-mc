# PlugForge

AI agent that builds and improves [Paper](https://papermc.io/) plugins from a plain-language request. It asks clarifying questions, plans the work in phases, writes the tests first, then the code, and fixes it until everything is green: the build, the MockBukkit unit tests and live scenarios played by a bot on a real Paper server.

```
plugforge create "A /home command: players save up to 3 homes and teleport to them after a 3 second delay"
```

The result is a ready `.jar`, the full Gradle project with its tests, and a player/admin manual written from the finished code.

## How it works

1. **Clarify.** The agent asks a few questions about anything the request leaves open (permissions, limits, messages, storage).
2. **Plan.** It splits the plugin into build phases and shows you the plan. You approve it once.
3. **Per phase:** a spec with acceptance criteria → unit tests (MockBukkit) → live scenarios → code.
4. **Check and fix.** Every phase is built and tested; failures go back to the model with the test output. After several failed attempts it escalates to a stronger model; tests the model believes are wrong can be disputed and reviewed instead of gamed.
5. **Deliver.** The last green state is copied to `dist/` together with the manual. If a phase cannot be made green, the project rolls back to the last green state.

`improve` works the same way on a plugin the agent already built: new phases go on top, all old tests and scenarios stay as regression, and a broken change is rolled back.

## Requirements

- Node.js 20 or newer.
- An OpenAI-compatible LLM API key. The defaults use [DeepSeek](https://platform.deepseek.com/).
- Windows is the main platform. macOS and Linux should work but are less tested.

Java 21, Gradle and the Paper server are downloaded and checked by `setup`; you don't need to install them yourself.

## Quick start

```bash
git clone https://github.com/ThisGod02/plugforge-mc.git
cd plugforge-mc
npm install

npm run cli -- setup                  # download Java, Gradle and Paper
npm run cli -- key set deepseek       # store your API key
npm run cli -- llm ping               # check the model answers

npm run cli -- create "your plugin idea" --out ./my-plugin
```

The live tests run a local Paper server, so you have to accept the [Minecraft EULA](https://aka.ms/MinecraftEULA) once with `--accept-eula`. The server listens on localhost only.

For a long or non-English request, put it in a UTF-8 file and pass `--request-file request.txt`; some consoles mangle pasted text.

## Commands

| Command | What it does |
| --- | --- |
| `setup` | Download and verify Java, Gradle and Paper for the test bench |
| `create "<request>"` | Build a new plugin from a text request (`--out <dir>`, `--yes` to take the recommended answers, `--answers <file.json>`, `--review-specs`, `--max-fix <n>`, `--request-file <file>`, `--skip-live`) |
| `improve <dir> "<change>"` | Add to or change a plugin the agent built; same flags as `create` without `--out` |
| `check <dir>` | Build, validate `plugin.yml` and run the unit and live tests; on an agent project also refreshes `dist/` |
| `run <spec.json>` | Build a plugin from a ready spec instead of a text request |
| `new <dir>` | Create an empty plugin project from the template (`--name`, `--package`) |
| `key set <name>` | Store an API key |
| `llm ping [route]` | Send one tiny request through the configured model |
| `smoke` | Start a test server, join with a bot, chat, stop |
| `selftest` | Run the bench fixtures and compare with the expected results |

Run `npm run cli -- --help` for the full list of options.

## Configuration

Everything PlugForge downloads or creates lives in its home folder: `~/.plugforge` on Windows, `~/Library/Application Support/PlugForge` on macOS, `~/.local/share/plugforge` on Linux. Set `PLUGFORGE_HOME` to move it.

**API keys.** `key set <name>` stores a key under that name; on Windows it is encrypted with DPAPI for your user account. A key can also come from the environment: `PLUGFORGE_KEY_<NAME>` or `<NAME>_API_KEY` (for example `DEEPSEEK_API_KEY`).

**Models.** Each step of the pipeline (`clarify`, `plan`, `spec`, `tests`, `scenarios`, `code`, `fix`, `fix_escalation`, `report`, ...) is routed to a model profile. Override profiles, routing or the per-task budget in `<home>/llm.json`, for example to use another OpenAI-compatible endpoint:

```json
{
  "profiles": {
    "flash": { "baseUrl": "https://api.example.com/v1", "model": "some-model", "apiKeyRef": "example", "maxTokens": 64000 }
  },
  "routing": { "fix_escalation": "flash" },
  "budget": { "maxCostUsdPerTask": 5 }
}
```

Profiles you list replace the default profile of the same name whole; routing and budget are merged key by key.

## Project layout

```
packages/
  cli/       command line entry point
  core/      the agent: LLM gateway, orchestrator, prompts, spec schema
  bench/     test bench: Gradle build, MockBukkit runner, live Paper server and bot scenarios
  runtime/   Java, Gradle and Paper downloads, paths
java/        plugin template and the test harness plugin
examples/    sample specs with ready tests
```

Target versions (Minecraft, Paper build, MockBukkit, Gradle) are pinned in [`bench.versions.json`](bench.versions.json).

## License

[MIT](LICENSE)
