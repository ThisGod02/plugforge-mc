export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** USD per 1M tokens. */
export interface Pricing {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
  /** Rates are multiplied during these UTC hour ranges [from, to) on weekdays (DeepSeek peak pricing). */
  peak?: { multiplier: number; utcHours: [number, number][] };
}

export interface LlmProfile {
  /** OpenAI-compatible base URL; requests go to `${baseUrl}/chat/completions`. */
  baseUrl: string;
  model: string;
  /** Name of the stored key (`plugforge key set <ref>`), also looked up as PLUGFORGE_KEY_<REF> / <REF>_API_KEY. */
  apiKeyRef: string;
  /** Provider-specific request fields, e.g. DeepSeek's `thinking`. */
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  pricing?: Pricing;
}

/** Agent stages that call a model; each one is routed to a profile. */
export type Route = "clarify" | "spec" | "tests" | "test_review" | "plan" | "code" | "fix" | "fix_escalation" | "report";

export interface LlmConfig {
  profiles: Record<string, LlmProfile>;
  routing: Record<Route, string>;
  budget: { maxCostUsdPerTask: number };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  reasoningTokens: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  json?: boolean;
  /** Overrides the profile's maxTokens (the gateway raises it after a truncated answer). */
  maxTokens?: number;
  /** Not sent to the provider; lets the scripted model check it is answering the expected stage. */
  route?: Route;
}

export interface ChatResponse {
  content: string;
  reasoning?: string;
  usage: Usage;
  finishReason?: string;
}

/** One model endpoint. Real ones talk HTTP; the scripted one replays canned answers. */
export interface ChatModel {
  complete(req: ChatRequest): Promise<ChatResponse>;
}
