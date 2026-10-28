import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Bot } from "mineflayer";
import { stringify } from "yaml";
import { homePaths, type JavaRuntime, type Log, type PaperInstall } from "@plugforge/runtime";
import type { LiveStageResult, ScenarioResult, ScenarioStepResult } from "../build/types.ts";
import { connectBot } from "./bot.ts";
import type { Scenario, Step } from "./scenario.ts";
import { TestServer } from "./server.ts";

/** Vanilla console replies that mean the command did nothing. */
const CONSOLE_FAILURE =
  /^(No entity was found|No player was found|No targets matched|Unknown or incomplete command|Incorrect argument|Invalid|Unknown (item|block|entity|effect)|Expected |Can't |Unable to |That position is not loaded)/im;

export interface LiveTestOptions {
  java: JavaRuntime;
  paper: PaperInstall;
  harnessJar: string;
  pluginJar: string;
  /** `name` from plugin.yml: Paper keeps the plugin's data in plugins/<name>/. */
  pluginName: string;
  minecraftVersion: string;
  scenarios: Scenario[];
  log?: Log;
  /** Whole-scenario limit (default 150 s). */
  scenarioTimeoutMs?: number;
  /**
   * Scenarios to play first (ids). In a fix loop these are the ones that failed last time: if
   * one of them fails again, the rest are not played, since the result is a failure anyway.
   */
  first?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Server log lines that point at a real problem (plugin exceptions, failed enable, command errors). */
const ERROR_LINE = /\sERROR\]:|Exception|Caused by:|^\s+at [\w$.]+\(|Could not pass event|Unhandled exception|Error occurred while/;
const NOISE = /No key layers|Ambiguity between arguments|moved (too quickly|wrongly)|Can't keep up|UUID of added entity already exists|Disconnecting .*: (Took too long|Internal Exception)/;

// --- text helpers ---------------------------------------------------------

/** Mineflayer hands out chat components as strings, JSON, or NBT-shaped objects; flatten to text. */
export function plain(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    const t = v.trim();
    if (/^[{["]/.test(t)) {
      try {
        return plain(JSON.parse(t));
      } catch {
        // plain text that happens to start with a bracket
      }
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(plain).join("");
  const o = v as Record<string, unknown>;
  // NBT shape: {type: "string", value: "..."} / {type: "compound", value: {...}} / {type: "list", value: {type, value: []}}
  if (typeof o.type === "string" && "value" in o && Object.keys(o).length === 2) {
    if (o.type === "compound") return plain(Object.fromEntries(Object.entries(o.value as object).map(([k, x]) => [k, nbt(x)])));
    if (o.type === "list") return plain(((o.value as { value?: unknown[] })?.value ?? []).map(nbt));
    return plain(o.value);
  }
  let s = typeof o.text === "string" ? o.text : typeof o[""] === "string" ? (o[""] as string) : "";
  if (!s && typeof o.translate === "string") s = o.translate;
  if (o.extra) s += plain(o.extra);
  return s;
}
function nbt(x: unknown): unknown {
  const o = x as { type?: string; value?: unknown };
  if (o && typeof o === "object" && typeof o.type === "string" && "value" in o) {
    if (o.type === "compound") return Object.fromEntries(Object.entries(o.value as object).map(([k, v]) => [k, nbt(v)]));
    if (o.type === "list") return ((o.value as { value?: unknown[] })?.value ?? []).map(nbt);
    return o.value;
  }
  return x;
}

function nested(dotted: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dotted)) {
    const parts = key.split(".");
    let node = out;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]!] = value;
  }
  return out;
}

// --- bots -----------------------------------------------------------------

interface Player {
  name: string;
  bot?: Bot;
  messages: string[];
  /** expect_chat searches from here; it moves past each matched message. */
  cursor: number;
}

interface WindowView {
  title: string;
  items: { slot: number; name: string; item: string }[];
}

function windowView(bot: Bot): WindowView | undefined {
  const w = bot.currentWindow;
  if (!w) return undefined;
  const items: WindowView["items"] = [];
  for (let slot = 0; slot < w.inventoryStart; slot++) {
    const it = w.slots[slot];
    if (!it) continue;
    const custom = plain((it as unknown as { customName?: unknown }).customName);
    items.push({ slot, name: custom || it.displayName, item: it.name });
  }
  return { title: plain(w.title), items };
}

const describeWindow = (v?: WindowView) =>
  v ? `menu "${v.title}": ${v.items.map((i) => `[${i.slot}] ${i.name}`).join(", ") || "(empty)"}` : "no menu open";

class StepFailure extends Error {}

// --- runner ---------------------------------------------------------------

class ScenarioRun {
  readonly players = new Map<string, Player>();
  /** Permissions granted in this scenario, re-applied after a restart. */
  private readonly perms: string[] = [];

  constructor(
    private server: TestServer,
    private readonly o: LiveTestOptions,
    private readonly startServer: () => Promise<TestServer>,
    private readonly scenario: Scenario,
  ) {}

  get currentServer(): TestServer {
    return this.server;
  }

  async join(name: string): Promise<void> {
    const p = this.players.get(name) ?? { name, messages: [], cursor: 0 };
    this.players.set(name, p);
    const bot = await connectBot({ port: this.server.port, username: name, version: this.o.minecraftVersion });
    bot.on("messagestr", (msg: string) => {
      p.messages.push(msg);
    });
    p.bot = bot;
    await sleep(400); // let join handlers of the plugin run
    p.cursor = p.messages.length;
  }

  async quit(name: string): Promise<void> {
    const p = this.players.get(name);
    if (!p?.bot) return;
    p.bot.quit();
    p.bot = undefined;
    await sleep(500);
  }

  async quitAll(): Promise<void> {
    for (const p of this.players.values()) if (p.bot) await this.quit(p.name);
  }

  private bot(name: string | undefined): { p: Player; bot: Bot } {
    const p = this.players.get(name ?? "");
    if (!p?.bot) throw new StepFailure(`player ${name} is not online`);
    return { p, bot: p.bot };
  }

  private async poll<T>(seconds: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      const v = await probe();
      if (v !== undefined) return v;
      if (Date.now() >= end) return undefined;
      await sleep(100);
    }
  }

  private async state(player: string): Promise<Record<string, unknown>> {
    const out = await this.server.command(`pfh state ${player}`);
    try {
      return JSON.parse(out.trim()) as Record<string, unknown>;
    } catch {
      throw new StepFailure(`harness answered: ${out.trim().slice(0, 200)}`);
    }
  }

  async run(step: Step): Promise<string | undefined> {
    // Shapes were checked by parseScenario; this is just the untyped view of the argument.
    const a = step.arg as Record<string, string | number | boolean | undefined>;
    switch (step.action) {
      case "command":
      case "chat": {
        const { p, bot } = this.bot(step.as);
        p.cursor = Math.min(p.cursor, p.messages.length);
        bot.chat(String(step.arg));
        await sleep(250);
        return;
      }
      case "expect_chat":
      case "expect_no_chat": {
        const { p } = this.bot(step.as);
        const spec = typeof step.arg === "string" ? { contains: step.arg } : (step.arg as { contains?: string; equals?: string; within?: number });
        const matches = (m: string) => (spec.equals !== undefined ? m.trim() === spec.equals : m.includes(spec.contains!));
        const want = spec.equals !== undefined ? `exactly "${spec.equals}"` : `containing "${spec.contains}"`;
        if (step.action === "expect_chat") {
          const idx = await this.poll(spec.within ?? 5, () => {
            const i = p.messages.findIndex((m, k) => k >= p.cursor && matches(m));
            return i >= 0 ? i : undefined;
          });
          if (idx === undefined) {
            const seen = p.messages.slice(p.cursor).slice(-8);
            throw new StepFailure(`expected a message ${want} within ${spec.within ?? 5}s; ${p.name} got ${seen.length ? seen.map((m) => `"${m}"`).join(", ") : "nothing"}`);
          }
          p.cursor = idx + 1;
          return;
        }
        await sleep((spec.within ?? 2) * 1000);
        const bad = p.messages.slice(p.cursor).find(matches);
        if (bad !== undefined) throw new StepFailure(`expected no message ${want}, but ${p.name} got "${bad}"`);
        return;
      }
      case "expect_gui": {
        const { bot } = this.bot(step.as);
        const spec = typeof step.arg === "string" ? { title_contains: step.arg } : (step.arg as { title_contains?: string; has_item?: string; lacks_item?: string; within?: number });
        const ok = (v: WindowView) =>
          (!spec.title_contains || v.title.includes(spec.title_contains)) &&
          (!spec.has_item || v.items.some((i) => i.name.includes(spec.has_item!))) &&
          (!spec.lacks_item || !v.items.some((i) => i.name.includes(spec.lacks_item!)));
        const view = await this.poll(spec.within ?? 5, () => {
          const v = windowView(bot);
          return v && ok(v) ? v : undefined;
        });
        if (!view) throw new StepFailure(`expected a menu${spec.title_contains ? ` titled "…${spec.title_contains}…"` : ""}${spec.has_item ? ` with an item "…${spec.has_item}…"` : ""}${spec.lacks_item ? ` without "…${spec.lacks_item}…"` : ""}; ${describeWindow(windowView(bot))}`);
        return;
      }
      case "expect_no_gui": {
        const { bot } = this.bot(step.as);
        const closed = await this.poll(2, () => (bot.currentWindow ? undefined : true));
        if (!closed) throw new StepFailure(`expected the menu to be closed; ${describeWindow(windowView(bot))}`);
        return;
      }
      case "click_item":
      case "click_slot": {
        const { bot } = this.bot(step.as);
        const view = await this.poll(3, () => windowView(bot));
        if (!view) throw new StepFailure(`cannot click: no menu open`);
        const slot = step.action === "click_slot" ? (step.arg as number) : view.items.find((i) => i.name.includes(String(step.arg)))?.slot;
        if (slot === undefined) throw new StepFailure(`no item "…${String(step.arg)}…" in ${describeWindow(view)}`);
        await bot.clickWindow(slot, 0, 0).catch(() => {});
        await sleep(400);
        return;
      }
      case "close_gui": {
        const { bot } = this.bot(step.as);
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
        await sleep(300);
        return;
      }
      case "console": {
        const out = (await this.server.command(String(step.arg))).trim();
        // Vanilla answers a bad command with text, not an error; a silent no-op hides broken setup.
        if (CONSOLE_FAILURE.test(out)) throw new StepFailure(`console "${step.arg}" failed: ${out.slice(0, 300)}`);
        return out || undefined;
      }
      case "expect_console": {
        const out = await this.server.command(String(a.command));
        if (!out.includes(String(a.contains))) throw new StepFailure(`console "${a.command}" answered "${out.trim().slice(0, 300)}", expected it to contain "${a.contains}"`);
        return;
      }
      case "op":
      case "deop":
        await this.server.command(`${step.action} ${step.arg}`);
        await sleep(200);
        return;
      case "perm": {
        const cmd = `pfh perm ${a.player} ${a.node} ${a.value === false ? "false" : "true"}`;
        this.perms.push(cmd);
        const out = await this.server.command(cmd);
        if (!out.includes("PFH OK")) throw new StepFailure(`harness answered "${out.trim()}"`);
        return;
      }
      case "give":
        await this.server.command(`give ${a.player} minecraft:${a.item} ${a.count ?? 1}`);
        await sleep(200);
        return;
      case "teleport":
        await this.server.command(`tp ${a.player} ${a.x} ${a.y} ${a.z}`);
        await sleep(300);
        return;
      case "damage":
        // Vanilla /damage goes through the real damage pipeline, so EntityDamageEvent fires.
        await this.server.command(`damage ${a.player} ${a.amount}`);
        await sleep(300);
        return;
      case "kill": {
        const out = await this.server.command(`pfh kill ${a.player} ${a.target}`);
        if (!out.includes("PFH OK")) throw new StepFailure(`harness answered "${out.trim()}"`);
        await sleep(300);
        return out.replace("PFH OK ", "").trim();
      }
      case "expect_state":
        return this.expectState(step.arg as Record<string, unknown>);
      case "expect_entities":
        return this.expectEntities(step.arg as Record<string, unknown>);
      case "wait":
        await sleep((step.arg as number) * 1000);
        return;
      case "restart":
        await this.restart();
        return;
      case "quit":
        await this.quit(String(step.arg));
        return;
      case "join":
        await this.join(String(step.arg));
        return;
    }
  }

  private async expectState(c: Record<string, unknown>): Promise<undefined> {
    const player = String(c.player);
    const problems = (s: Record<string, unknown>): string[] => {
      const out: string[] = [];
      const inv = (s.inventory as { item: string; amount: number; name?: string }[] | undefined) ?? [];
      if (c.online !== undefined && s.online !== c.online) out.push(`online is ${s.online}, expected ${c.online}`);
      if (s.online === false && c.online !== false) return [`${player} is offline`];
      if (typeof c.health === "number" && Math.abs((s.health as number) - c.health) > 0.01) out.push(`health is ${s.health}, expected ${c.health}`);
      if (typeof c.health_below === "number" && !((s.health as number) < c.health_below)) out.push(`health is ${s.health}, expected below ${c.health_below}`);
      if (typeof c.food === "number" && s.food !== c.food) out.push(`food is ${s.food}, expected ${c.food}`);
      if (typeof c.gamemode === "string" && s.gamemode !== c.gamemode.toLowerCase()) out.push(`gamemode is ${s.gamemode}, expected ${c.gamemode}`);
      if (c.near && typeof c.near === "object") {
        const n = c.near as { x: number; y: number; z: number; radius?: number };
        const d = Math.hypot((s.x as number) - n.x, (s.y as number) - n.y, (s.z as number) - n.z);
        if (d > (n.radius ?? 2)) out.push(`position is ${(s.x as number).toFixed(1)} ${(s.y as number).toFixed(1)} ${(s.z as number).toFixed(1)}, expected within ${n.radius ?? 2} of ${n.x} ${n.y} ${n.z}`);
      }
      if (c.has_item) {
        const h = (typeof c.has_item === "string" ? { item: c.has_item } : c.has_item) as { item: string; min?: number; count?: number; name_contains?: string };
        const total = inv.filter((i) => i.item === h.item && (!h.name_contains || (i.name ?? "").includes(h.name_contains))).reduce((n, i) => n + i.amount, 0);
        if (h.count !== undefined ? total !== h.count : total < (h.min ?? 1)) out.push(`has ${total} ${h.item}, expected ${h.count !== undefined ? `exactly ${h.count}` : `at least ${h.min ?? 1}`}`);
      }
      if (typeof c.lacks_item === "string" && inv.some((i) => i.item === c.lacks_item)) out.push(`has ${c.lacks_item}, expected none`);
      if (typeof c.open_title_contains === "string") {
        const title = (s.open as { title?: string } | undefined)?.title;
        if (!title?.includes(c.open_title_contains)) out.push(`open menu is ${title ? `"${title}"` : "none"}, expected a title containing "${c.open_title_contains}"`);
      }
      return out;
    };
    let last: string[] = [];
    const ok = await this.poll(typeof c.within === "number" ? c.within : 3, async () => {
      last = problems(await this.state(player));
      return last.length === 0 ? true : undefined;
    });
    if (!ok) throw new StepFailure(`${player}: ${last.join("; ")}`);
    return undefined;
  }

  private async expectEntities(c: Record<string, unknown>): Promise<undefined> {
    const radius = typeof c.radius === "number" ? c.radius : 16;
    const describe = () =>
      `${c.count !== undefined ? `exactly ${c.count}` : [c.min !== undefined ? `at least ${c.min}` : "", c.max !== undefined ? `at most ${c.max}` : ""].filter(Boolean).join(" and ")}` +
      ` ${c.type ?? "entities"}${c.name_contains ? ` named "…${c.name_contains}…"` : ""} within ${radius} blocks of ${c.player}`;
    let seen: { type: string; name?: string }[] = [];
    const ok = await this.poll(typeof c.within === "number" ? c.within : 5, async () => {
      const out = await this.server.command(`pfh entities ${c.player} ${radius}`);
      try {
        seen = JSON.parse(out.trim()) as { type: string; name?: string }[];
      } catch {
        throw new StepFailure(`harness answered: ${out.trim().slice(0, 200)}`);
      }
      const n = seen.filter((e) => (!c.type || e.type === c.type) && (!c.name_contains || (e.name ?? "").includes(String(c.name_contains)))).length;
      const fine = (c.count === undefined || n === c.count) && (c.min === undefined || n >= (c.min as number)) && (c.max === undefined || n <= (c.max as number));
      return fine ? true : undefined;
    });
    if (!ok) {
      const tally = new Map<string, number>();
      for (const e of seen) tally.set(e.name ? `${e.type} "${e.name}"` : e.type, (tally.get(e.name ? `${e.type} "${e.name}"` : e.type) ?? 0) + 1);
      throw new StepFailure(`expected ${describe()}; found ${tally.size ? [...tally].map(([k, n]) => `${n}× ${k}`).join(", ") : "nothing"}`);
    }
    return undefined;
  }

  /** Stops and starts the server in the same folder (plugin data kept), then rejoins everyone. */
  async restart(): Promise<void> {
    const online = [...this.players.values()].filter((p) => p.bot).map((p) => p.name);
    for (const p of this.players.values()) p.bot = undefined;
    await this.server.stop();
    this.server = await this.startServer();
    for (const cmd of this.perms) await this.server.command(cmd);
    for (const name of online) await this.join(name);
  }

  context(as?: string): string {
    const out: string[] = [];
    for (const p of this.players.values()) {
      const recent = p.messages.slice(-6);
      out.push(`${p.name} chat (last ${recent.length}): ${recent.length ? recent.map((m) => `"${m}"`).join(", ") : "nothing"}`);
    }
    const who = this.players.get(as ?? this.scenario.players[0]!);
    if (who?.bot) out.push(`${who.name} sees ${describeWindow(windowView(who.bot))}`);
    return out.join("\n");
  }
}

function serverErrors(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) if (ERROR_LINE.test(l) && !NOISE.test(l)) out.push(l.length > 300 ? `${l.slice(0, 300)}…` : l);
  return out.slice(0, 25);
}

/**
 * L2: plays every scenario on a real Paper server with bots. Each scenario starts from a clean
 * slate (plugin data, player data and ops wiped, config overrides written, server restarted), so
 * scenarios cannot affect one another.
 */
export async function runLiveTests(o: LiveTestOptions): Promise<LiveStageResult> {
  const started = Date.now();
  const log = o.log ?? (() => {});
  const results: ScenarioResult[] = [];
  // One folder for all scenarios: the world is generated once, everything else is reset per scenario.
  const dir = path.join(homePaths.servers(), `live-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  const servers: TestServer[] = [];
  const start = async () => {
    const s = await TestServer.start({ java: o.java, paper: o.paper, eulaAccepted: true, plugins: [o.harnessJar, o.pluginJar], keepDir: true, dir, log: () => {} });
    servers.push(s);
    return s;
  };

  const firstIds = new Set(o.first ?? []);
  const ordered = [...o.scenarios.filter((s) => firstIds.has(s.id)), ...o.scenarios.filter((s) => !firstIds.has(s.id))];
  const firstCount = ordered.filter((s) => firstIds.has(s.id)).length;
  let notPlayed = 0;

  try {
    for (const [index, sc] of ordered.entries()) {
      if (index === firstCount && firstCount > 0 && results.some((r) => r.status === "failed")) {
        notPlayed = ordered.length - index;
        log(`L2: ${results.filter((r) => r.status === "failed").length} of the ${firstCount} scenario(s) that failed before still fail; not playing the other ${notPlayed}`);
        break;
      }
      const t0 = Date.now();
      log(`L2: scenario ${sc.id} (${sc.covers.join(", ")})`);
      const steps: ScenarioStepResult[] = [];
      let failure: string | undefined;
      let context: string | undefined;
      let server: TestServer | undefined;
      let run: ScenarioRun | undefined;
      let firstLine = 0;
      const firstServer = servers.length;

      try {
        // Clean slate: the plugin's own data, ops, and a freshly generated world — blocks and
        // mobs a previous scenario left behind must not leak into this one.
        await rm(path.join(dir, "plugins", o.pluginName), { recursive: true, force: true });
        for (const world of ["world", "world_nether", "world_the_end"]) {
          await rm(path.join(dir, world), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
        await writeFile(path.join(dir, "ops.json"), "[]");
        if (sc.config) {
          // Only the overridden keys: Bukkit fills the rest from the config.yml inside the jar.
          await mkdir(path.join(dir, "plugins", o.pluginName), { recursive: true });
          await writeFile(path.join(dir, "plugins", o.pluginName, "config.yml"), stringify(nested(sc.config)));
        }
        server = await start();
        const failedEnable = server.lines.find((l) => l.includes(`Error occurred while enabling ${o.pluginName}`));
        if (failedEnable || !server.lines.some((l) => l.includes(`Enabling ${o.pluginName}`))) {
          throw new StepFailure(`the plugin did not enable: ${failedEnable ?? `no "Enabling ${o.pluginName}" line in the server log`}`);
        }
        firstLine = server.lines.length;
        run = new ScenarioRun(server, o, start, sc);
        for (const name of sc.players) await run.join(name);

        const all = [...sc.setup.map((s, i) => ({ s, at: `setup ${i + 1}` })), ...sc.steps.map((s, i) => ({ s, at: `step ${i + 1}` }))];
        const deadline = t0 + (o.scenarioTimeoutMs ?? 150_000);
        for (const { s, at } of all) {
          if (Date.now() > deadline) throw new StepFailure(`scenario took longer than ${(o.scenarioTimeoutMs ?? 150_000) / 1000}s`);
          try {
            const detail = await run.run(s);
            steps.push({ at, text: s.text, ok: true, detail });
          } catch (err) {
            steps.push({ at, text: s.text, ok: false, detail: (err as Error).message });
            failure = `${at} (${s.text}) failed: ${(err as Error).message}`;
            context = run.context(s.as);
            break;
          }
        }
        await sleep(500);
      } catch (err) {
        failure ??= (err as Error).message;
      } finally {
        await run?.quitAll().catch(() => {});
        await (run?.currentServer ?? server)?.stop().catch(() => {});
      }

      // Every process of this scenario counts (a restart step starts a new one); for the first,
      // only lines after startup, so the enable phase is judged separately above.
      const used = servers.slice(firstServer);
      const errors = serverErrors(used.flatMap((s, i) => (i === 0 ? s.lines.slice(firstLine) : s.lines)));
      if (!failure && errors.length) failure = `the server logged ${errors.length} error line(s) during the scenario`;
      results.push({
        id: sc.id,
        file: sc.file,
        covers: sc.covers,
        status: failure ? "failed" : "passed",
        durationMs: Date.now() - t0,
        steps,
        failure,
        context,
        serverErrors: errors,
      });
      log(`L2: ${sc.id} ${failure ? "FAILED" : "passed"} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
  }

  const failed = results.filter((r) => r.status === "failed").length;
  return {
    ok: failed === 0,
    durationMs: Date.now() - started,
    diagnostics: [],
    total: results.length + notPlayed,
    passed: results.length - failed,
    failed,
    ...(notPlayed ? { notPlayed } : {}),
    scenarios: results,
  };
}
