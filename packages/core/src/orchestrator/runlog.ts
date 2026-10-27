import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckResult } from "@plugforge/bench";
import { homePaths } from "@plugforge/runtime";
import type { LlmCall } from "../llm/gateway.ts";

/**
 * Full record of one agent run in `<PlugForge>/runs/<id>/`. Stays on the user's machine;
 * these request → working plugin and error → fix pairs are the future training set.
 *
 *   run.json          spec, settings, final status, totals
 *   events.jsonl      state transitions
 *   llm/0001-*.json   every model call: messages, reply, usage, cost
 *   checks/iter-N.json, snapshots/iter-N/src/main/...
 */
export class RunLog {
  private constructor(readonly id: string, readonly dir: string) {}

  static async create(root = homePaths.runs()): Promise<RunLog> {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const id = `${stamp}-${randomBytes(2).toString("hex")}`;
    const dir = path.join(root, id);
    await mkdir(path.join(dir, "llm"), { recursive: true });
    return new RunLog(id, dir);
  }

  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    await appendFile(path.join(this.dir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
  }

  async llmCall(call: LlmCall): Promise<void> {
    const slug = call.label.replace(/[^A-Za-z0-9.]+/g, "_").slice(0, 60);
    await writeFile(path.join(this.dir, "llm", `${String(call.seq).padStart(4, "0")}-${slug}.json`), JSON.stringify(call, null, 2));
  }

  async check(iteration: number, result: CheckResult): Promise<void> {
    await mkdir(path.join(this.dir, "checks"), { recursive: true });
    await writeFile(path.join(this.dir, "checks", `iter-${iteration}.json`), JSON.stringify(result, null, 2));
  }

  async snapshot(iteration: number, projectDir: string): Promise<void> {
    const src = path.join(projectDir, "src", "main");
    if (existsSync(src)) await cp(src, path.join(this.dir, "snapshots", `iter-${iteration}`, "src", "main"), { recursive: true });
  }

  async write(summary: Record<string, unknown>): Promise<void> {
    await writeFile(path.join(this.dir, "run.json"), JSON.stringify({ id: this.id, ...summary }, null, 2));
  }
}
