import { createInterface } from "node:readline/promises";
import type { Answer, ClarifyQuestion, PluginSpec } from "@plugforge/core";

/** Answers for non-interactive runs, consumed in order: a number picks an option (1-based), a string is a free answer, null takes the recommended option. */
export type ScriptedAnswers = (number | string | null)[];

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Free text that may be pasted as several lines: lines arriving together are joined, and the
 * answer ends on an empty line or when nothing more arrives for a moment after the last one.
 * A plain Enter (empty first line) answers "".
 */
export async function askLines(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(question);
  rl.prompt();
  const lines: string[] = [];
  try {
    return await new Promise<string>((resolve) => {
      let idle: NodeJS.Timeout | undefined;
      const done = () => resolve(lines.join("\n").trim());
      rl.on("line", (line) => {
        clearTimeout(idle);
        if (!line.trim()) return done();
        lines.push(line.trim());
        idle = setTimeout(done, 500);
      });
      rl.on("close", done);
    });
  } finally {
    rl.close();
  }
}

function pick(q: ClarifyQuestion, raw: number | string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return q.options[0]!;
  if (typeof raw === "number" || /^\d+$/.test(raw)) {
    const option = q.options[Number(raw) - 1];
    if (!option) throw new Error(`answer ${raw} is not an option of "${q.question}"`);
    return option;
  }
  return raw;
}

/** Shows clarifying questions and collects answers from the terminal, the answers file or the defaults. */
export async function answerQuestions(questions: ClarifyQuestion[], opts: { scripted?: ScriptedAnswers; useDefaults: boolean }): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const [i, q] of questions.entries()) {
    console.log(`\n${i + 1}/${questions.length}. ${q.question}`);
    q.options.forEach((o, k) => console.log(`   ${k + 1}) ${o}${k === 0 ? "  (recommended)" : ""}`));
    let answer: string;
    if (opts.scripted) answer = pick(q, opts.scripted.shift());
    else if (opts.useDefaults || !interactive()) answer = q.options[0]!;
    else {
      for (;;) {
        try {
          answer = pick(q, await askLines("   Number, your own answer, or Enter for 1: "));
          break;
        } catch (err) {
          console.log(`   ${(err as Error).message}`);
        }
      }
    }
    console.log(`   → ${answer}`);
    answers.push({ question: q.question, answer });
  }
  return answers;
}

/** Readable spec for approval. */
export function renderSpec(spec: PluginSpec): string {
  const out: string[] = [];
  out.push(`${spec.name}  (${spec.package}.${spec.mainClass})`, `  ${spec.description}`, "", "Commands:");
  for (const c of spec.commands) {
    out.push(`  ${c.usage}  — ${c.description}${c.permission ? `  [${c.permission}]` : ""}${c.playerOnly ? "  (players only)" : ""}`);
  }
  if (spec.permissions?.length) {
    out.push("", "Permissions:");
    for (const p of spec.permissions) out.push(`  ${p.node}  default: ${p.default}${p.description ? `  — ${p.description}` : ""}`);
  }
  if (spec.config?.length) {
    out.push("", "Config (config.yml):");
    for (const c of spec.config) out.push(`  ${c.key}: ${JSON.stringify(c.default)}  (${c.type})${c.description ? `  — ${c.description}` : ""}`);
  }
  if (spec.guis?.length) {
    out.push("", "Menus:");
    for (const g of spec.guis) {
      out.push(`  "${g.title}" (${g.rows} rows${g.openedBy ? `, opened by ${g.openedBy}` : ""})`);
      for (const i of g.items) out.push(`    [${i.slot ?? "?"}] ${i.name} (${i.material}) — ${i.action}`);
    }
  }
  const messages = Object.entries(spec.messages ?? {});
  if (messages.length) {
    out.push("", "Messages:");
    for (const [k, v] of messages) out.push(`  ${k}: ${v}`);
  }
  out.push("", "Acceptance criteria:");
  for (const a of spec.acceptance) out.push(`  ${a.id}  ${a.text}`);
  if (spec.assumptions?.length) {
    out.push("", "Assumptions (defaults I chose):");
    for (const a of spec.assumptions) out.push(`  - ${a}`);
  }
  return out.join("\n");
}

/** What a phase adds to the previous phase's spec. */
export function renderSpecDiff(prev: PluginSpec, next: PluginSpec): string {
  const out: string[] = [];
  const add = (title: string, lines: string[]) => {
    if (lines.length) out.push("", `${title}:`, ...lines.map((l) => `  ${l}`));
  };
  const known = <T,>(xs: T[] | undefined, key: (x: T) => string) => new Set((xs ?? []).map(key));
  const commands = known(prev.commands, (c) => `${c.name}|${c.usage}`);
  add("New or changed commands", next.commands.filter((c) => !commands.has(`${c.name}|${c.usage}`)).map((c) => `${c.usage}  — ${c.description}${c.permission ?? c.checksPermission ? `  [${c.permission ?? c.checksPermission}]` : ""}`));
  const perms = known(prev.permissions, (p) => p.node);
  add("New permissions", (next.permissions ?? []).filter((p) => !perms.has(p.node)).map((p) => `${p.node}  default: ${p.default}`));
  const keys = known(prev.config, (c) => c.key);
  add("New settings", (next.config ?? []).filter((c) => !keys.has(c.key)).map((c) => `${c.key}: ${JSON.stringify(c.default)}  (${c.type})${c.description ? `  — ${c.description}` : ""}`));
  const guis = known(prev.guis, (g) => g.id);
  add("New menus", (next.guis ?? []).filter((g) => !guis.has(g.id)).flatMap((g) => [`"${g.title}" (${g.rows} rows)`, ...g.items.map((i) => `  ${i.name} (${i.material}) — ${i.action}`)]));
  add("New messages", Object.entries(next.messages ?? {}).filter(([k]) => prev.messages?.[k] === undefined).map(([k, v]) => `${k}: ${v}`));
  const ids = known(prev.acceptance, (a) => a.id);
  add("New acceptance criteria", next.acceptance.filter((a) => !ids.has(a.id)).map((a) => `${a.id}  ${a.text}`));
  const assumptions = new Set(prev.assumptions ?? []);
  add("New assumptions", (next.assumptions ?? []).filter((a) => !assumptions.has(a)).map((a) => `- ${a}`));
  return out.join("\n").trimStart() || "(nothing new)";
}

export type ApprovalDecision = { action: "approve" } | { action: "revise"; feedback: string } | { action: "cancel" };

/** Asks the user to approve the spec (or a plan), request changes, or cancel. */
export async function askApproval(spec: PluginSpec | undefined, what = "this spec"): Promise<ApprovalDecision> {
  for (;;) {
    const a = (await ask(`\nApprove ${what}? [Y]es / [e]dit (describe changes)${spec ? " / [j]son" : ""} / [n]o: `)).toLowerCase();
    if (a === "" || a === "y" || a === "yes" || a === "д" || a === "да") return { action: "approve" };
    if (a === "n" || a === "no" || a === "н" || a === "нет") return { action: "cancel" };
    if (spec && (a === "j" || a === "json")) {
      console.log(JSON.stringify(spec, null, 2));
      continue;
    }
    if (a === "e" || a === "edit" || a === "и") {
      const feedback = await askLines("What should change? (pasting several lines is fine) ");
      if (feedback) return { action: "revise", feedback };
      continue;
    }
    console.log(`Please answer y, e${spec ? ", j" : ""} or n.`);
  }
}
