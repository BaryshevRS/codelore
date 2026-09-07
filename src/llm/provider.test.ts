import { describe, expect, it } from "vitest";
import type { CodeloreConfig } from "../types.js";
import { createConfiguredProvider } from "./provider.js";

function config(): CodeloreConfig {
  return {
    rootDir: "/r",
    sourceGlobs: [],
    docGlobs: [],
    excludeGlobs: [],
    indexDir: ".codelore",
    docs: {
      translations: [],
      writingRules: [],
      terms: [],
      blockHeadings: {} as CodeloreConfig["docs"]["blockHeadings"],
      blockHeadingsByLanguage: {},
    },
    thresholds: { weightMinimal: 1, weightFull: 3, minScore: 0.5, classFieldOverlap: 0.5 },
    blockInclusion: { enabled: true, stdlibPrefixes: [], significantGlobals: [] },
    llm: {
      provider: "test",
      providers: {
        test: {
          type: "openai-compatible",
          baseUrl: "https://example.test/v1/",
          model: "test-model",
          apiKey: "key",
        },
      },
      concurrency: 1,
      verifyTypeContext: true,
    },
  };
}

function sseResponse(deltas: string[], usage?: Record<string, unknown>): Response {
  const lines = [
    ...deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`),
    ...(usage ? [`data: ${JSON.stringify({ choices: [], usage })}\n\n`] : []),
    "data: [DONE]\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAiCompatibleProvider", () => {
  it("requests streaming and assembles SSE deltas into the full content", async () => {
    let requestBody = "";
    const provider = createConfiguredProvider(config(), undefined, {
      env: {},
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body);
        return sseResponse(['{"sections', '":{}}']);
      }) as typeof fetch,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "hi" }] })).resolves.toEqual({
      content: '{"sections":{}}',
    });
    expect(JSON.parse(requestBody)).toMatchObject({
      stream: true,
      model: "test-model",
      stream_options: { include_usage: true },
    });
    // no responseFormat configured → no response_format field
    expect(JSON.parse(requestBody).response_format).toBeUndefined();
  });

  it("sends response_format when the provider config opts into json_object", async () => {
    let requestBody = "";
    const withFormat = config();
    withFormat.llm.providers.test.responseFormat = "json_object";
    const provider = createConfiguredProvider(withFormat, undefined, {
      env: {},
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body);
        return sseResponse(['{"a":1}']);
      }) as typeof fetch,
    });

    await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse(requestBody).response_format).toEqual({ type: "json_object" });
  });

  it("sends strict json_schema when the config opts in and the request carries a schema", async () => {
    let requestBody = "";
    const withFormat = config();
    withFormat.llm.providers.test.responseFormat = "json_schema";
    const provider = createConfiguredProvider(withFormat, undefined, {
      env: {},
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body);
        return sseResponse(['{"a":1}']);
      }) as typeof fetch,
    });

    const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
    await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      responseSchema: { name: "file_write", schema },
    });
    expect(JSON.parse(requestBody).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "file_write", strict: true, schema },
    });
  });

  it("falls back to json_object when json_schema is configured but the request has no schema", async () => {
    let requestBody = "";
    const withFormat = config();
    withFormat.llm.providers.test.responseFormat = "json_schema";
    const provider = createConfiguredProvider(withFormat, undefined, {
      env: {},
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body);
        return sseResponse(['{"a":1}']);
      }) as typeof fetch,
    });

    await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse(requestBody).response_format).toEqual({ type: "json_object" });
  });

  it("ignores a request schema when the config only opts into json_object", async () => {
    let requestBody = "";
    const withFormat = config();
    withFormat.llm.providers.test.responseFormat = "json_object";
    const provider = createConfiguredProvider(withFormat, undefined, {
      env: {},
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body);
        return sseResponse(['{"a":1}']);
      }) as typeof fetch,
    });

    await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      responseSchema: { name: "file_write", schema: { type: "object" } },
    });
    expect(JSON.parse(requestBody).response_format).toEqual({ type: "json_object" });
  });

  it("parses usage from the final SSE chunk, including DeepSeek cache hits", async () => {
    const provider = createConfiguredProvider(config(), undefined, {
      env: {},
      fetch: (async () =>
        sseResponse(["ok"], {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 64,
          completion_tokens_details: { reasoning_tokens: 7 },
        })) as typeof fetch,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "hi" }] })).resolves.toEqual({
      content: "ok",
      usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 64, reasoningTokens: 7 },
    });
  });

  it("falls back to plain JSON when the provider ignores stream:true", async () => {
    const provider = createConfiguredProvider(config(), undefined, {
      env: {},
      fetch: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "plain" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )) as typeof fetch,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "hi" }] })).resolves.toEqual({
      content: "plain",
      usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 0 },
    });
  });

  it("throws on an empty stream", async () => {
    const provider = createConfiguredProvider(config(), undefined, {
      env: {},
      fetch: (async () => sseResponse([])) as typeof fetch,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /streamed no message content/
    );
  });

  it("retries a 429 with backoff and then succeeds", async () => {
    let calls = 0;
    const provider = createConfiguredProvider(config(), undefined, {
      env: {},
      fetch: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
        }
        return sseResponse(["ok"]);
      }) as typeof fetch,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "hi" }] })).resolves.toEqual({
      content: "ok",
    });
    expect(calls).toBe(2);
  });

  it("gives up after the retry cap on persistent 503", async () => {
    let calls = 0;
    const provider = createConfiguredProvider(config(), undefined, {
      env: {},
      fetch: (async () => {
        calls += 1;
        return new Response("unavailable", { status: 503, headers: { "retry-after": "0" } });
      }) as typeof fetch,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(4);
  });

  it("does not retry a non-retryable 400", async () => {
    let calls = 0;
    const provider = createConfiguredProvider(config(), undefined, {
      env: {},
      fetch: (async () => {
        calls += 1;
        return new Response("bad request", { status: 400 });
      }) as typeof fetch,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });
});
