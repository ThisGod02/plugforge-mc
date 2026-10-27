import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

/**
 * Live-test scenario (L2), stored as YAML in <project>/src/test/scenarios/. Played by Mineflayer
 * bots on a real Paper server; see packages/core/prompts/live-dsl.md for the format.
 */
export interface Scenario {
  id: string;
  /** Project-relative file. */
  file: string;
  covers: string[];
  description?: string;
  /** Bot usernames; the first one is the default `as`. */
  players: string[];
  /** Overrides written to the plugin's config.yml before the server starts (dotted keys). */
  config?: Record<string, unknown>;
  setup: Step[];
  steps: Step[];
}

export interface Step {
  action: Action;
  arg: unknown;
  /** Player who performs or observes the step. */
  as?: string;
  /** The step as written, for reports. */
  text: string;
}

/** Actions performed or observed by a bot (need `as` when there is more than one player). */
const BOT_ACTIONS = [
  "command",
  "chat",
  "expect_chat",
  "expect_no_chat",
  "expect_gui",
  "expect_no_gui",
  "click_item",
  "click_slot",
  "close_gui",
] as const;
/** Actions done through the server console or the harness. */
const SERVER_ACTIONS = [
  "console",
  "expect_console",
  "op",
  "deop",
  "perm",
  "give",
  "teleport",
  "damage",
  "expect_state",
  "wait",
  "restart",
  "quit",
  "join",
] as const;
export type Action = (typeof BOT_ACTIONS)[number] | (typeof SERVER_ACTIONS)[number];
const ACTIONS = new Set<string>([...BOT_ACTIONS, ...SERVER_ACTIONS]);
export const isBotAction = (a: Action) => (BOT_ACTIONS as readonly string[]).includes(a);

const PLAYER = /^[A-Za-z0-9_]{3,16}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ITEM = /^[a-z0-9_]+$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Checks one action's argument; returns problems (empty when fine). */
function checkArg(action: Action, arg: unknown, players: Set<string>): string[] {
  const player = (p: unknown, what = "player") => (isStr(p) && players.has(p) ? [] : [`${what} '${String(p)}' is not in 'players'`]);
  const keys = (o: Obj, allowed: string[]) => Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `unknown field '${k}'`);
  switch (action) {
    case "command":
      return isStr(arg) && arg.startsWith("/") ? [] : ["command must be a string starting with /"];
    case "chat":
    case "console":
    case "click_item":
      return isStr(arg) ? [] : [`${action} must be a non-empty string`];
    case "click_slot":
      return Number.isInteger(arg) && (arg as number) >= 0 && (arg as number) < 54 ? [] : ["click_slot must be a slot number 0-53"];
    case "close_gui":
    case "expect_no_gui":
    case "restart":
      return arg === true ? [] : [`${action} takes the value true`];
    case "wait":
      return isNum(arg) && arg > 0 && arg <= 120 ? [] : ["wait must be 0-120 seconds"];
    case "op":
    case "deop":
    case "quit":
    case "join":
      return player(arg);
    case "expect_chat":
    case "expect_no_chat":
      if (isStr(arg)) return [];
      if (!isObj(arg)) return [`${action} must be a string or {contains, within}`];
      return [
        ...keys(arg, ["contains", "equals", "within"]),
        ...(isStr(arg.contains) || isStr(arg.equals) ? [] : ["needs 'contains' or 'equals'"]),
        ...(arg.within === undefined || isNum(arg.within) ? [] : ["'within' must be seconds"]),
      ];
    case "expect_gui":
      if (isStr(arg)) return [];
      if (!isObj(arg)) return ["expect_gui must be a title string or {title_contains, has_item, within}"];
      return [
        ...keys(arg, ["title_contains", "has_item", "lacks_item", "within"]),
        ...(isStr(arg.title_contains) || isStr(arg.has_item) || isStr(arg.lacks_item) ? [] : ["needs title_contains, has_item or lacks_item"]),
      ];
    case "expect_console":
      return isObj(arg) && isStr(arg.command) && isStr(arg.contains) ? keys(arg, ["command", "contains"]) : ["expect_console needs {command, contains}"];
    case "perm":
      return isObj(arg) && isStr(arg.node)
        ? [...keys(arg, ["player", "node", "value"]), ...player(arg.player), ...(arg.value === undefined || typeof arg.value === "boolean" ? [] : ["'value' must be true or false"])]
        : ["perm needs {player, node, value}"];
    case "give":
      return isObj(arg) && isStr(arg.item) && ITEM.test(arg.item)
        ? [...keys(arg, ["player", "item", "count"]), ...player(arg.player), ...(arg.count === undefined || (Number.isInteger(arg.count) && (arg.count as number) > 0) ? [] : ["'count' must be a positive integer"])]
        : ["give needs {player, item: vanilla id like diamond, count}"];
    case "teleport":
      return isObj(arg) && isNum(arg.x) && isNum(arg.y) && isNum(arg.z) ? [...keys(arg, ["player", "x", "y", "z"]), ...player(arg.player)] : ["teleport needs {player, x, y, z}"];
    case "damage":
      return isObj(arg) && isNum(arg.amount) && arg.amount > 0 ? [...keys(arg, ["player", "amount"]), ...player(arg.player)] : ["damage needs {player, amount}"];
    case "expect_state": {
      if (!isObj(arg)) return ["expect_state needs {player, ...checks}"];
      const allowed = ["player", "online", "health", "health_below", "food", "gamemode", "near", "has_item", "lacks_item", "open_title_contains", "within"];
      const checks = Object.keys(arg).filter((k) => k !== "player" && k !== "within");
      return [...keys(arg, allowed), ...player(arg.player), ...(checks.length ? [] : ["expect_state needs at least one check"])];
    }
  }
}

function parseSteps(raw: unknown, where: string, players: string[], errors: string[]): Step[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where} must be a list of steps`);
    return [];
  }
  const set = new Set(players);
  const steps: Step[] = [];
  raw.forEach((s, i) => {
    const at = `${where} ${i + 1}`;
    if (!isObj(s)) return void errors.push(`${at}: a step is a mapping like {command: /x} or {as: alice, command: /x}`);
    const actions = Object.keys(s).filter((k) => k !== "as");
    const unknown = actions.filter((k) => !ACTIONS.has(k));
    if (unknown.length) return void errors.push(`${at}: unknown action ${unknown.join(", ")}`);
    if (actions.length !== 1) return void errors.push(`${at}: exactly one action per step, found ${actions.join(", ") || "none"}`);
    const action = actions[0] as Action;
    let as = s.as as string | undefined;
    if (isBotAction(action)) {
      if (as === undefined && players.length === 1) as = players[0];
      if (as === undefined) return void errors.push(`${at}: '${action}' needs 'as: <player>' when there are several players`);
      if (!set.has(as)) return void errors.push(`${at}: as '${as}' is not in 'players'`);
    }
    let arg = s[action];
    // Player-targeted server actions: `as` (which models write naturally) names the player, and a
    // single-player scenario needs neither.
    const targeted = ["perm", "give", "teleport", "damage", "expect_state"].includes(action);
    if (!isBotAction(action) && as !== undefined) {
      if (!targeted || !isObj(arg)) return void errors.push(`${at}: '${action}' is a server action and takes no 'as'`);
      if (arg.player !== undefined && arg.player !== as) return void errors.push(`${at}: 'as: ${as}' and 'player: ${String(arg.player)}' disagree`);
      if (!set.has(as)) return void errors.push(`${at}: as '${as}' is not in 'players'`);
      arg = { ...arg, player: as };
      as = undefined;
    }
    if (players.length === 1 && targeted && isObj(arg) && arg.player === undefined) arg = { ...arg, player: players[0] };
    for (const p of checkArg(action, arg, set)) errors.push(`${at} (${action}): ${p}`);
    steps.push({ action, arg, as, text: `${as && players.length > 1 ? `[${as}] ` : ""}${action}: ${JSON.stringify(arg)}` });
  });
  return steps;
}

/** Parses and validates one scenario file; `criteria` are the spec's acceptance ids. */
export function parseScenario(text: string, file: string, criteria?: string[]): { scenario?: Scenario; errors: string[] } {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { errors: [`not valid YAML: ${(err as Error).message.split("\n")[0]}`] };
  }
  if (!isObj(doc)) return { errors: ["a scenario is a YAML mapping with id, covers, players, steps"] };
  const known = ["id", "covers", "description", "players", "config", "setup", "steps"];
  for (const k of Object.keys(doc)) if (!known.includes(k)) errors.push(`unknown top-level field '${k}'`);

  const id = doc.id;
  if (!isStr(id) || !ID.test(id)) errors.push("id: lowercase letters, digits, - and _");
  const covers = Array.isArray(doc.covers) ? doc.covers.map(String) : [];
  if (covers.length === 0) errors.push("covers: list the acceptance ids (e.g. [AC3]) or 'extra' for behaviour beyond them");
  if (criteria) for (const c of covers) if (c !== "extra" && !criteria.includes(c)) errors.push(`covers: '${c}' is not an acceptance id of the spec`);
  const players = Array.isArray(doc.players) ? doc.players.map(String) : [];
  if (players.length < 1 || players.length > 4) errors.push("players: 1-4 bot names");
  for (const p of players) if (!PLAYER.test(p)) errors.push(`players: '${p}' must be 3-16 letters, digits or _`);
  if (new Set(players.map((p) => p.toLowerCase())).size !== players.length) errors.push("players: names must be unique");
  if (doc.config !== undefined && !isObj(doc.config)) errors.push("config: a mapping of config.yml keys (dotted) to values");

  const setup = parseSteps(doc.setup, "setup", players, errors);
  const steps = parseSteps(doc.steps, "step", players, errors);
  if (steps.length === 0) errors.push("steps: at least one step");
  if (steps.length + setup.length > 60) errors.push("too many steps (max 60)");
  if (errors.length) return { errors };
  return {
    errors,
    scenario: {
      id: id as string,
      file,
      covers,
      description: typeof doc.description === "string" ? doc.description : undefined,
      players,
      config: doc.config as Record<string, unknown> | undefined,
      setup,
      steps,
    },
  };
}

export const SCENARIO_DIR = "src/test/scenarios";

/** Loads every scenario of a project; `errors` maps file → problems for invalid ones. */
export async function loadScenarios(projectDir: string, criteria?: string[]): Promise<{ scenarios: Scenario[]; errors: Map<string, string[]> }> {
  const dir = path.join(projectDir, SCENARIO_DIR);
  const scenarios: Scenario[] = [];
  const errors = new Map<string, string[]>();
  if (!existsSync(dir)) return { scenarios, errors };
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  const ids = new Set<string>();
  for (const f of files) {
    const rel = `${SCENARIO_DIR}/${f}`;
    const r = parseScenario(await readFile(path.join(dir, f), "utf8"), rel, criteria);
    if (r.scenario && ids.has(r.scenario.id)) r.errors.push(`id '${r.scenario.id}' is used by another scenario`);
    if (r.errors.length || !r.scenario) errors.set(rel, r.errors);
    else {
      ids.add(r.scenario.id);
      scenarios.push(r.scenario);
    }
  }
  return { scenarios, errors };
}
