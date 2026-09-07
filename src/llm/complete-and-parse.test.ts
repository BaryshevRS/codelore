import { describe, expect, it, vi } from "vitest";
import { CodeloreError } from "../errors.js";
import { completeAndParse } from "./complete-and-parse.js";
import type { GenerationDebugLlmPipelineInput } from "./generation-debug.js";
import type { ChatCompletionInput, ChatCompletionProvider } from "./provider.js";

const budget = { maxPromptTokens: 100000, charsPerToken: 4, maxSectionsPerChunk: 6 };

function fakeProvider(responses: string[]): ChatCompletionProvider & { calls: ChatCompletionInput[] } {
  const calls: ChatCompletionInput[] = [];
  return {
    name: "fake",
    model: "fake-model",
    writerBudget: budget,
    calls,
    complete: vi.fn(async (input: ChatCompletionInput) => {
      calls.push(input);
      const next = responses.shift();
      if (next === undefined) {
        throw new Error("fake provider exhausted");
      }
      return { content: next };
    }),
  };
}

const baseRequest: ChatCompletionInput = {
  messages: [
    { role: "system", content: "You return JSON." },
    { role: "user", content: 'Return {"value": 42}.' },
  ],
};

const parseValue = (content: string): { value: number } => {
  const parsed = JSON.parse(content) as { value: unknown };
  if (typeof parsed.value !== "number") {
    throw new CodeloreError("INVALID_LLM_RESPONSE", `value must be a number, got ${typeof parsed.value}`);
  }
  return { value: parsed.value };
};

describe("completeAndParse", () => {
  it("returns parsed result on first successful response", async () => {
    const provider = fakeProvider(['{"value":42}']);
    const llmStages: GenerationDebugLlmPipelineInput = {};
    const writeDebug = vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" }));

    const result = await completeAndParse({
      provider,
      llmStages,
      stageName: "fileGeneration",
      request: baseRequest,
      parse: parseValue,
      writeDebug,
      requestErrorStage: "file_generation_request",
      parseErrorStage: "file_generation_parse",
      maxRetries: 1,
    });

    expect(result).toEqual({ value: 42 });
    expect(provider.calls).toHaveLength(1);
    expect(writeDebug).not.toHaveBeenCalled();
    expect(llmStages.fileGeneration).toEqual({
      request: baseRequest,
      response: { content: '{"value":42}' },
    });
  });

  it("stores provider usage in the debug stage", async () => {
    const provider: ChatCompletionProvider = {
      name: "fake",
      model: "fake-model",
      writerBudget: budget,
      complete: vi.fn(async () => ({
        content: '{"value":42}',
        usage: { promptTokens: 9, completionTokens: 3, cachedPromptTokens: 0 },
      })),
    };
    const llmStages: GenerationDebugLlmPipelineInput = {};

    await completeAndParse({
      provider,
      llmStages,
      stageName: "fileGeneration",
      request: baseRequest,
      parse: parseValue,
      writeDebug: vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" })),
      requestErrorStage: "file_generation_request",
      parseErrorStage: "file_generation_parse",
      maxRetries: 0,
    });

    expect(llmStages.fileGeneration).toEqual({
      request: baseRequest,
      response: { content: '{"value":42}', usage: { promptTokens: 9, completionTokens: 3, cachedPromptTokens: 0 } },
    });
  });

  it("retries on INVALID_LLM_RESPONSE with feedback message and succeeds", async () => {
    const provider = fakeProvider(['{"value":"oops"}', '{"value":7}']);
    const llmStages: GenerationDebugLlmPipelineInput = {};
    const writeDebug = vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" }));

    const result = await completeAndParse({
      provider,
      llmStages,
      stageName: "fileGeneration",
      request: baseRequest,
      parse: parseValue,
      writeDebug,
      requestErrorStage: "file_generation_request",
      parseErrorStage: "file_generation_parse",
      maxRetries: 1,
    });

    expect(result).toEqual({ value: 7 });
    expect(provider.calls).toHaveLength(2);
    expect(writeDebug).not.toHaveBeenCalled();

    const retryMessages = provider.calls[1]?.messages ?? [];
    expect(retryMessages).toHaveLength(baseRequest.messages.length + 2);
    expect(retryMessages.at(-2)).toEqual({ role: "assistant", content: '{"value":"oops"}' });
    const feedback = retryMessages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("was rejected");
    expect(feedback?.content).toContain("value must be a number");
    expect(feedback?.content).toContain("No prose, no markdown, no code fences");

    expect(llmStages.fileGeneration?.response.content).toBe('{"value":7}');
  });

  it("keeps the request's responseSchema on the retry request", async () => {
    const provider = fakeProvider(['{"value":"oops"}', '{"value":7}']);
    const responseSchema = { name: "test", schema: { type: "object" } };

    await completeAndParse({
      provider,
      llmStages: {},
      stageName: "fileGeneration",
      request: { ...baseRequest, responseSchema },
      parse: parseValue,
      writeDebug: vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" })),
      requestErrorStage: "file_generation_request",
      parseErrorStage: "file_generation_parse",
      maxRetries: 1,
    });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.responseSchema).toEqual(responseSchema);
  });

  it("does not retry when maxRetries is 0", async () => {
    const provider = fakeProvider(['{"value":"oops"}']);
    const llmStages: GenerationDebugLlmPipelineInput = {};
    const writeDebug = vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" }));

    await expect(
      completeAndParse({
        provider,
        llmStages,
        stageName: "fileGeneration",
        request: baseRequest,
        parse: parseValue,
        writeDebug,
        requestErrorStage: "file_generation_request",
        parseErrorStage: "file_generation_parse",
        maxRetries: 0,
      })
    ).rejects.toMatchObject({ code: "INVALID_LLM_RESPONSE" });

    expect(provider.calls).toHaveLength(1);
    expect(writeDebug).toHaveBeenCalledTimes(1);
    expect(writeDebug.mock.calls[0]?.[0]).toMatchObject({
      error: { stage: "file_generation_parse", code: "INVALID_LLM_RESPONSE" },
    });
  });

  it("gives up after maxRetries and writes debug with the parse error stage", async () => {
    const provider = fakeProvider(['{"value":"a"}', '{"value":"b"}']);
    const llmStages: GenerationDebugLlmPipelineInput = {};
    const writeDebug = vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" }));

    await expect(
      completeAndParse({
        provider,
        llmStages,
        stageName: "fileGeneration",
        request: baseRequest,
        parse: parseValue,
        writeDebug,
        requestErrorStage: "file_generation_request",
        parseErrorStage: "file_generation_parse",
        parseExtra: { extractedClaims: [] },
        maxRetries: 1,
      })
    ).rejects.toMatchObject({ code: "INVALID_LLM_RESPONSE" });

    expect(provider.calls).toHaveLength(2);
    expect(writeDebug).toHaveBeenCalledTimes(1);
    expect(writeDebug.mock.calls[0]?.[0]).toMatchObject({
      extractedClaims: [],
      error: { stage: "file_generation_parse" },
    });
  });

  it("retries once with the same request when the provider streams no content", async () => {
    let attempts = 0;
    const provider: ChatCompletionProvider = {
      name: "fake",
      model: "fake-model",
      writerBudget: budget,
      complete: vi.fn(async (input: ChatCompletionInput) => {
        attempts += 1;
        if (attempts === 1) {
          throw new CodeloreError("INVALID_LLM_RESPONSE", "streamed no message content");
        }
        expect(input).toEqual(baseRequest);
        return { content: '{"value":5}' };
      }),
    };
    const llmStages: GenerationDebugLlmPipelineInput = {};
    const writeDebug = vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" }));

    const result = await completeAndParse({
      provider,
      llmStages,
      stageName: "fileGeneration",
      request: baseRequest,
      parse: parseValue,
      writeDebug,
      requestErrorStage: "file_generation_request",
      parseErrorStage: "file_generation_parse",
      maxRetries: 1,
    });

    expect(result).toEqual({ value: 5 });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(writeDebug).not.toHaveBeenCalled();
  });

  it("does not retry on transport errors and writes the request-stage debug", async () => {
    const provider: ChatCompletionProvider = {
      name: "fake",
      model: "fake-model",
      writerBudget: budget,
      complete: vi.fn(async () => {
        throw new CodeloreError("LLM_PROVIDER_ERROR", "boom");
      }),
    };
    const llmStages: GenerationDebugLlmPipelineInput = {};
    const writeDebug = vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" }));

    await expect(
      completeAndParse({
        provider,
        llmStages,
        stageName: "fileGeneration",
        request: baseRequest,
        parse: parseValue,
        writeDebug,
        requestErrorStage: "file_generation_request",
        parseErrorStage: "file_generation_parse",
        maxRetries: 3,
      })
    ).rejects.toMatchObject({ code: "LLM_PROVIDER_ERROR" });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(writeDebug).toHaveBeenCalledTimes(1);
    expect(writeDebug.mock.calls[0]?.[0]).toMatchObject({
      error: { stage: "file_generation_request", code: "LLM_PROVIDER_ERROR" },
    });
  });

  it("forwards the parser cause to the retry feedback when available", async () => {
    const provider = fakeProvider(["{not really json}", '{"value":1}']);
    const llmStages: GenerationDebugLlmPipelineInput = {};
    const writeDebug = vi.fn(async (_extra: Record<string, unknown>) => ({ debugPath: "/tmp/debug.json" }));

    const parseWithCause = (content: string): { value: number } => {
      try {
        return parseValue(content);
      } catch {
        throw new CodeloreError("INVALID_LLM_RESPONSE", "could not parse", {
          cause: "syntax error at column 3",
          response: content,
        });
      }
    };

    await completeAndParse({
      provider,
      llmStages,
      stageName: "fileGeneration",
      request: baseRequest,
      parse: parseWithCause,
      writeDebug,
      requestErrorStage: "file_generation_request",
      parseErrorStage: "file_generation_parse",
      maxRetries: 1,
    });

    const feedback = provider.calls[1]?.messages.at(-1)?.content ?? "";
    expect(feedback).toContain("Error: could not parse");
    expect(feedback).toContain("Cause: syntax error at column 3");
  });
});
