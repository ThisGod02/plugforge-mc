import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatModel, ChatRequest, ChatResponse, Route } from "./types.ts";

interface ScriptedReply {
  /** Stage the reply is meant for; a mismatch fails loudly instead of feeding code to the wrong stage. */
  route: Route;
  content?: string;
  /** Path relative to the script file, for replies too long to inline. */
  contentFile?: string;
}

/**
 * Replays canned replies in order. Used to test the orchestrator end to end (real Gradle,
 * real file edits) without a network or an API key.
 */
export class ScriptedModel implements ChatModel {
  private next = 0;

  private constructor(
    private readonly replies: ScriptedReply[],
    private readonly baseDir: string,
  ) {}

  static async load(file: string): Promise<ScriptedModel> {
    const script = JSON.parse(await readFile(file, "utf8")) as { replies: ScriptedReply[] };
    return new ScriptedModel(script.replies, path.dirname(file));
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const reply = this.replies[this.next];
    if (!reply) throw new Error(`scripted model has no reply #${this.next + 1} (asked for ${req.route})`);
    // A mismatch leaves the reply queued, so a stage that tolerates failure does not shift the script.
    if (req.route && reply.route !== req.route) {
      throw new Error(`scripted reply #${this.next + 1} is for '${reply.route}', but the agent asked for '${req.route}'`);
    }
    this.next++;
    const content = reply.contentFile ? await readFile(path.join(this.baseDir, reply.contentFile), "utf8") : (reply.content ?? "");
    const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
    // Rough token estimate so cost/budget code paths still run.
    return { content, usage: { promptTokens: Math.ceil(chars / 4), completionTokens: Math.ceil(content.length / 4), cacheHitTokens: 0, reasoningTokens: 0 } };
  }

  get remaining(): number {
    return this.replies.length - this.next;
  }
}
