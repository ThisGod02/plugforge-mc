import { OpenAiCompatibleModel, costUsd } from "./client.ts";
import { resolveApiKey } from "./keys.ts";
import type { ChatMessage, ChatModel, ChatResponse, LlmConfig, Route, Usage } from "./types.ts";

export class BudgetExceededError extends Error {}

export class TruncatedError extends Error {
  constructor(
    message: string,
    readonly maxTokens: number,
  ) {
    super(message);
  }
}

const TRUNCATION_RETRY_CAP = 128_000;

/** Everything about one model call; the run log stores these as training data. */
export interface LlmCall {
  seq: number;
  route: Route;
  label: string;
  profile: string;
  model: string;
  messages: ChatMessage[];
  content?: string;
  reasoning?: string;
  usage?: Usage;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface LlmTotals {
  calls: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
}

export type ModelFactory = (profileName: string) => Promise<ChatModel>;

/** Routes stage calls to profiles, enforces the per-task budget and accounts tokens and cost. */
export class LlmGateway {
  readonly totals: LlmTotals = { calls: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 };
  private readonly models = new Map<string, Promise<ChatModel>>();
  private seq = 0;

  constructor(
    readonly config: LlmConfig,
    private readonly factory: ModelFactory,
    private readonly onCall?: (call: LlmCall) => void | Promise<void>,
  ) {}

  /** Gateway backed by real HTTP endpoints; API keys are resolved on first use of a profile. */
  static http(config: LlmConfig, onCall?: (call: LlmCall) => void | Promise<void>): LlmGateway {
    return new LlmGateway(
      config,
      async (name) => {
        const profile = config.profiles[name]!;
        const key = await resolveApiKey(profile.apiKeyRef);
        const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(profile.baseUrl);
        if (!key && !local) {
          throw new Error(
            `no API key '${profile.apiKeyRef}' for profile '${name}'. ` +
              `Run: plugforge key set ${profile.apiKeyRef}  (or set ${profile.apiKeyRef.toUpperCase()}_API_KEY)`,
          );
        }
        return new OpenAiCompatibleModel(profile, key);
      },
      onCall,
    );
  }

  profileFor(route: Route): string {
    return this.config.routing[route];
  }

  /**
   * One stage call. A reply cut off by max_tokens (usually a reasoning model thinking too long)
   * is retried once with double the limit, capped at TRUNCATION_RETRY_CAP.
   */
  async chat(route: Route, messages: ChatMessage[], opts: { json?: boolean; label?: string } = {}): Promise<ChatResponse> {
    try {
      return await this.once(route, messages, opts);
    } catch (err) {
      if (!(err instanceof TruncatedError) || err.maxTokens >= TRUNCATION_RETRY_CAP) throw err;
      const maxTokens = Math.min(err.maxTokens * 2, TRUNCATION_RETRY_CAP);
      return this.once(route, messages, { ...opts, maxTokens, label: `${opts.label ?? route}.retry-${maxTokens}` });
    }
  }

  private async once(route: Route, messages: ChatMessage[], opts: { json?: boolean; label?: string; maxTokens?: number }): Promise<ChatResponse> {
    const limit = this.config.budget.maxCostUsdPerTask;
    if (this.totals.costUsd >= limit) {
      throw new BudgetExceededError(`budget of $${limit} per task is used up ($${this.totals.costUsd.toFixed(4)} spent)`);
    }
    const profileName = this.profileFor(route);
    const profile = this.config.profiles[profileName]!;
    let model = this.models.get(profileName);
    if (!model) {
      model = this.factory(profileName);
      this.models.set(profileName, model);
      model.catch(() => this.models.delete(profileName));
    }

    const call: LlmCall = {
      seq: ++this.seq,
      route,
      label: opts.label ?? route,
      profile: profileName,
      model: profile.model,
      messages,
      costUsd: 0,
      durationMs: 0,
    };
    const started = Date.now();
    try {
      const res = await (await model).complete({ messages, json: opts.json, route, maxTokens: opts.maxTokens });
      call.content = res.content;
      call.reasoning = res.reasoning;
      call.usage = res.usage;
      call.costUsd = costUsd(res.usage, profile.pricing);
      this.totals.calls++;
      this.totals.costUsd += call.costUsd;
      this.totals.promptTokens += res.usage.promptTokens;
      this.totals.completionTokens += res.usage.completionTokens;
      this.totals.cacheHitTokens += res.usage.cacheHitTokens;
      if (res.finishReason === "length") {
        const used = opts.maxTokens ?? profile.maxTokens ?? res.usage.completionTokens;
        throw new TruncatedError(
          `${profile.model} hit max_tokens (${used}); the answer is truncated` +
            (res.usage.reasoningTokens >= res.usage.completionTokens * 0.9 ? " — almost all of it was reasoning" : ""),
          used,
        );
      }
      return res;
    } catch (err) {
      call.error = (err as Error).message;
      throw err;
    } finally {
      call.durationMs = Date.now() - started;
      await this.onCall?.(call);
    }
  }
}
