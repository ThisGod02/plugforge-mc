import type { ChatModel, ChatRequest, ChatResponse, LlmProfile, Pricing, Usage } from "./types.ts";

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OpenAiResponse {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
}

/** Chat Completions client for any OpenAI-compatible endpoint (DeepSeek, OpenRouter, Ollama, vLLM, LM Studio). */
export class OpenAiCompatibleModel implements ChatModel {
  constructor(
    private readonly profile: LlmProfile,
    private readonly apiKey: string | undefined,
  ) {}

  // Fixer calls with high reasoning on a big project run past 5 minutes on slow gateways.
  private get timeoutMs(): number {
    return this.profile.timeoutMs ?? 900_000;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const p = this.profile;
    const body: Record<string, unknown> = {
      model: p.model,
      messages: req.messages,
      stream: false,
      ...((req.maxTokens ?? p.maxTokens) ? { max_tokens: req.maxTokens ?? p.maxTokens } : {}),
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...p.extraBody,
    };

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.send(body);
      } catch (err) {
        const timedOut = (err as Error).name === "TimeoutError";
        const e = err instanceof LlmHttpError ? err : new LlmHttpError(timedOut ? `${this.profile.model}: no answer within ${this.timeoutMs / 1000}s` : (err as Error).message, undefined, true);
        // A request that timed out once is likely to time out again: one more try, not three.
        if (!e.retryable || attempt >= (timedOut ? 2 : MAX_ATTEMPTS)) throw e;
        await delay(2000 * 2 ** (attempt - 1));
      }
    }
  }

  private async send(body: Record<string, unknown>): Promise<ChatResponse> {
    const url = `${this.profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: OpenAiResponse | undefined;
    try {
      json = JSON.parse(text) as OpenAiResponse;
    } catch {
      // Gateways sometimes answer overload with an HTML page.
    }
    if (!res.ok) {
      const detail = json?.error?.message ?? text.slice(0, 300);
      throw new LlmHttpError(`${this.profile.model}: HTTP ${res.status}: ${detail}`, res.status, RETRYABLE_STATUS.has(res.status));
    }
    const choice = json?.choices?.[0];
    if (!choice?.message) throw new LlmHttpError(`${this.profile.model}: response has no message: ${text.slice(0, 300)}`, res.status, true);

    const u = json?.usage ?? {};
    const usage: Usage = {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    };
    return {
      content: choice.message.content ?? "",
      reasoning: choice.message.reasoning_content ?? undefined,
      usage,
      finishReason: choice.finish_reason,
    };
  }
}

/** Cost of one call in USD; 0 when the profile has no pricing (local models). */
export function costUsd(usage: Usage, pricing: Pricing | undefined, at = new Date()): number {
  if (!pricing) return 0;
  const hour = at.getUTCHours();
  const weekday = at.getUTCDay() >= 1 && at.getUTCDay() <= 5;
  const peak = weekday && pricing.peak?.utcHours.some(([from, to]) => hour >= from && hour < to);
  const k = peak ? pricing.peak!.multiplier : 1;
  const miss = Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  return (k * (usage.cacheHitTokens * pricing.inputCacheHit + miss * pricing.inputCacheMiss + usage.completionTokens * pricing.output)) / 1e6;
}
