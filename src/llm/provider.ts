import { CodeloreError } from "../errors.js";
import type { CodeloreConfig, LlmProviderConfig, OpenAiCompatibleProviderConfig, WriterBudget } from "../types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionInput {
  messages: ChatMessage[];
  /**
   * JSON Schema of the expected response shape (OpenAI strict dialect: every
   * property required, additionalProperties false, optionality via null type).
   * Sent as `response_format: json_schema` only when the provider config opts
   * into "json_schema"; ignored otherwise.
   */
  responseSchema?: ResponseSchema;
}

export interface ResponseSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  /** Hidden thinking tokens; billed inside completionTokens but absent from the content. */
  reasoningTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  usage?: ChatUsage;
}

export interface ChatCompletionProvider {
  name: string;
  model: string;
  /** Writer-chunk budget resolved from this provider's config. */
  writerBudget: WriterBudget;
  complete(input: ChatCompletionInput): Promise<ChatCompletionResult>;
}

/** Fallbacks for providers whose config omits budget fields (mirrors the timeoutMs/temperature defaults below). */
const DEFAULT_CONTEXT_WINDOW = 65536;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8192;
const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_SECTIONS_PER_CHUNK = 6;

export interface ProviderRuntime {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/** Total attempts (1 initial + 3 retries) for retryable transport failures. */
const MAX_TRANSPORT_ATTEMPTS = 4;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After is either delta-seconds or an HTTP date; returns ms or undefined. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * The `response_format` request field for the provider's configured capability.
 * "json_schema" + a request schema → strict constrained decoding; "json_schema"
 * without a schema falls back to json_object (a subset every json_schema-capable
 * endpoint accepts); "json_object" → syntax-only guarantee; unset → no field.
 */
function responseFormatField(
  format: "json_object" | "json_schema" | undefined,
  responseSchema: ResponseSchema | undefined
): Record<string, unknown> {
  if (!format) {
    return {};
  }
  if (format === "json_schema" && responseSchema) {
    return {
      // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
      response_format: {
        type: "json_schema",
        // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
        json_schema: { name: responseSchema.name, strict: true, schema: responseSchema.schema },
      },
    };
  }
  // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
  return { response_format: { type: "json_object" } };
}

/**
 * Backoff delay for a retryable transport failure, or undefined if the error is
 * not retryable / attempts are exhausted. Retryable = HTTP 429/5xx or a network/
 * abort error (a stalled stream is worth one more shot). Parse/content errors and
 * a missing key are not retried.
 */
function retryDelayMs(error: unknown, attempt: number, maxAttempts: number): number | undefined {
  if (attempt >= maxAttempts) {
    return undefined;
  }
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  const jittered = backoff * (0.8 + Math.random() * 0.4);
  if (error instanceof CodeloreError) {
    if (error.code !== "LLM_PROVIDER_ERROR") {
      return undefined;
    }
    const status = (error.details as { status?: unknown } | undefined)?.status;
    if (typeof status !== "number" || !RETRY_STATUSES.has(status)) {
      return undefined;
    }
    const retryAfter = (error.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
    return typeof retryAfter === "number" ? Math.max(retryAfter, jittered) : jittered;
  }
  // Network failure (fetch threw) or idle-timeout abort — transient, retry.
  return jittered;
}

export function createConfiguredProvider(
  config: CodeloreConfig,
  providerName: string | undefined,
  runtime: ProviderRuntime
): ChatCompletionProvider {
  const name = providerName ?? config.llm.provider;
  const providerConfig = config.llm.providers[name];
  if (!providerConfig) {
    const configuredProviders = Object.keys(config.llm.providers);
    // Nothing ships preconfigured, so an empty list is the first-run case, not a typo.
    throw new CodeloreError(
      "UNKNOWN_LLM_PROVIDER",
      configuredProviders.length === 0
        ? 'No LLM provider is configured. Add one under "llm.providers" in codelore.config.json (or .codelore/config.json) with type, baseUrl, model and apiKeyEnv, then set "llm.provider" to its name.'
        : `Unknown LLM provider "${name}"`,
      { provider: name, configuredProviders }
    );
  }

  return createProvider(name, providerConfig, runtime);
}

function resolveWriterBudget(config: OpenAiCompatibleProviderConfig): WriterBudget {
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const reservedOutputTokens = config.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  return {
    maxPromptTokens: contextWindow - reservedOutputTokens,
    charsPerToken: config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
    maxSectionsPerChunk: config.maxSectionsPerChunk ?? DEFAULT_MAX_SECTIONS_PER_CHUNK,
  };
}

function createProvider(name: string, config: LlmProviderConfig, runtime: ProviderRuntime): ChatCompletionProvider {
  if (config.type === "openai-compatible") {
    return new OpenAiCompatibleProvider(name, config, runtime);
  }

  const unsupported = (config as { type: string }).type;
  throw new CodeloreError("UNKNOWN_LLM_PROVIDER", `Unsupported LLM provider type "${unsupported}"`, {
    provider: name,
  });
}

class OpenAiCompatibleProvider implements ChatCompletionProvider {
  readonly model: string;
  readonly writerBudget: WriterBudget;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly name: string,
    private readonly config: OpenAiCompatibleProviderConfig,
    runtime: ProviderRuntime
  ) {
    this.model = config.model;
    this.writerBudget = resolveWriterBudget(config);
    this.apiKey = config.apiKey ?? (config.apiKeyEnv ? runtime.env[config.apiKeyEnv] : undefined);
    this.fetchImpl = runtime.fetch ?? fetch;
  }

  async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    if (!this.apiKey) {
      throw new CodeloreError(
        "MISSING_LLM_API_KEY",
        `LLM provider "${this.name}" requires an API key in ${this.config.apiKeyEnv ?? "config.llm.providers.*.apiKey"}`,
        { provider: this.name, apiKeyEnv: this.config.apiKeyEnv }
      );
    }

    // High concurrency makes throttling (429) and transient gateway errors routine,
    // so transport failures are retried with capped exponential backoff. Parse and
    // content errors are not retried here — the file pipeline owns those retries.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attemptComplete(input);
      } catch (error) {
        const delayMs = retryDelayMs(error, attempt, MAX_TRANSPORT_ATTEMPTS);
        if (delayMs === undefined) {
          throw error;
        }
        await sleep(delayMs);
      }
    }
  }

  private async attemptComplete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    // Streaming keeps bytes flowing during long generations, so timeoutMs acts
    // as an idle timeout (reset on every chunk) instead of a hard total cap.
    const idleMs = this.config.timeoutMs ?? 300000;
    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(), idleMs);
    const resetIdle = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), idleMs);
    };
    try {
      const response = await this.fetchImpl(chatCompletionsUrl(this.config.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: input.messages,
          temperature: this.config.temperature ?? 0.2,
          stream: true,
          // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
          stream_options: { include_usage: true },
          ...responseFormatField(this.config.responseFormat, input.responseSchema),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new CodeloreError("LLM_PROVIDER_ERROR", `LLM provider "${this.name}" returned HTTP ${response.status}`, {
          provider: this.name,
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
          body: text.slice(0, 1000),
        });
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return await this.readEventStream(response, resetIdle);
      }
      // Providers (and test mocks) that ignore stream:true answer with plain JSON.
      resetIdle();
      return extractOpenAiCompatibleResult(await response.text(), this.name);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readEventStream(response: Response, resetIdle: () => void): Promise<ChatCompletionResult> {
    if (!response.body) {
      throw new CodeloreError("INVALID_LLM_RESPONSE", `LLM provider "${this.name}" returned an empty stream body`, {
        provider: this.name,
      });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: ChatUsage | undefined;
    const consume = (line: string) => {
      const chunk = sseChunk(line);
      content += chunk.delta;
      usage = chunk.usage ?? usage;
    };
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consume(line);
      }
    }
    consume(buffer);
    if (content.trim().length === 0) {
      throw new CodeloreError("INVALID_LLM_RESPONSE", `LLM provider "${this.name}" streamed no message content`, {
        provider: this.name,
      });
    }
    return { content, ...(usage ? { usage } : {}) };
  }
}

function sseChunk(line: string): { delta: string; usage?: ChatUsage } {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return { delta: "" };
  }
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") {
    return { delta: "" };
  }
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
      usage?: unknown;
    };
    const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
    const usage = parseUsage(parsed.usage);
    return { delta: typeof delta === "string" ? delta : "", ...(usage ? { usage } : {}) };
  } catch {
    // Malformed keep-alive or comment lines are ignorable; real corruption
    // surfaces as empty content and fails the final check.
    return { delta: "" };
  }
}

interface RawChatUsage {
  // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
  prompt_tokens?: unknown;
  // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
  completion_tokens?: unknown;
  // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
  prompt_tokens_details?: { cached_tokens?: unknown };
  // biome-ignore lint/style/useNamingConvention: DeepSeek wire format uses snake_case
  prompt_cache_hit_tokens?: unknown;
  // biome-ignore lint/style/useNamingConvention: OpenAI wire format uses snake_case
  completion_tokens_details?: { reasoning_tokens?: unknown };
}

/** OpenAI-compatible usage; DeepSeek reports cache hits as prompt_cache_hit_tokens. */
function parseUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const usage = raw as RawChatUsage;
  if (typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") {
    return undefined;
  }
  const cached =
    typeof usage.prompt_cache_hit_tokens === "number"
      ? usage.prompt_cache_hit_tokens
      : usage.prompt_tokens_details?.cached_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    ...(typeof cached === "number" ? { cachedPromptTokens: cached } : {}),
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", normalized).toString();
}

function extractOpenAiCompatibleResult(text: string, provider: string): ChatCompletionResult {
  let parsed: { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
  try {
    parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
  } catch (error) {
    throw new CodeloreError("INVALID_LLM_RESPONSE", `LLM provider "${provider}" returned invalid JSON`, {
      provider,
      cause: error instanceof Error ? error.message : String(error),
      body: text.slice(0, 1000),
    });
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new CodeloreError("INVALID_LLM_RESPONSE", `LLM provider "${provider}" returned no message content`, {
      provider,
    });
  }

  const usage = parseUsage(parsed.usage);
  return { content, ...(usage ? { usage } : {}) };
}
