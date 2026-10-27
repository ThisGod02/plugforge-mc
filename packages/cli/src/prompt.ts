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
          answer = pick(q, await ask("   Number, your own answer, or Enter for 1: "));
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

export type ApprovalDecision = { action: "approve" } | { action: "revise"; feedback: string } | { action: "cancel" };

/** Asks the user to approve the spec, request changes, or cancel. */
export async function askApproval(spec: PluginSpec): Promise<ApprovalDecision> {
  for (;;) {
    const a = (await ask("\nApprove this spec? [Y]es / [e]dit (describe changes) / [j]son / [n]o: ")).toLowerCase();
    if (a === "" || a === "y" || a === "yes" || a === "д" || a === "да") return { action: "approve" };
    if (a === "n" || a === "no" || a === "н" || a === "нет") return { action: "cancel" };
    if (a === "j" || a === "json") {
      console.log(JSON.stringify(spec, null, 2));
      continue;
    }
    if (a === "e" || a === "edit" || a === "и") {
      const feedback = await ask("What should change? ");
      if (feedback) return { action: "revise", feedback };
      continue;
    }
    console.log("Please answer y, e, j or n.");
  }
}
