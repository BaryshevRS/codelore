import { CodeloreError } from "../errors.js";
import type {
  GenerationDebugError,
  GenerationDebugLlmPipelineInput,
  GenerationDebugLlmStageName,
} from "./generation-debug.js";
import type { ChatCompletionInput, ChatCompletionProvider, ChatCompletionResult, ChatMessage } from "./provider.js";

export interface CompleteAndParseArgs<T, DebugExtras> {
  provider: ChatCompletionProvider;
  llmStages: GenerationDebugLlmPipelineInput;
  stageName: GenerationDebugLlmStageName;
  request: ChatCompletionInput;
  parse: (content: string) => T;
  writeDebug: (extra: DebugExtras & { error?: GenerationDebugError }) => Promise<unknown>;
  requestErrorStage: GenerationDebugError["stage"];
  parseErrorStage: GenerationDebugError["stage"];
  parseExtra?: DebugExtras;
  maxRetries: number;
}

export async function completeAndParse<T, DebugExtras extends Record<string, unknown>>(
  args: CompleteAndParseArgs<T, DebugExtras>
): Promise<T> {
  let currentRequest = args.request;
  let lastParseError: unknown;

  for (let attempt = 0; attempt <= args.maxRetries; attempt += 1) {
    let completion: ChatCompletionResult;
    try {
      completion = await args.provider.complete(currentRequest);
    } catch (error) {
      // An empty/invalid stream is a provider flake worth one more attempt with
      // the same request; transport errors (HTTP, timeouts) stay fail-fast.
      if (attempt < args.maxRetries && isInvalidLlmResponse(error)) {
        lastParseError = error;
        continue;
      }
      await args.writeDebug({ error: errorForDebug(args.requestErrorStage, error) } as DebugExtras & {
        error: GenerationDebugError;
      });
      throw error;
    }

    const content = completion.content;
    const stage = {
      request: currentRequest,
      response: { content, ...(completion.usage ? { usage: completion.usage } : {}) },
    };
    try {
      const parsed = args.parse(content);
      args.llmStages[args.stageName] = stage;
      return parsed;
    } catch (error) {
      lastParseError = error;
      args.llmStages[args.stageName] = stage;
      if (attempt >= args.maxRetries || !isInvalidLlmResponse(error)) {
        await args.writeDebug({
          ...(args.parseExtra ?? ({} as DebugExtras)),
          error: errorForDebug(args.parseErrorStage, error),
        });
        throw error;
      }
      currentRequest = appendParseRetryFeedback(currentRequest, content, error);
    }
  }

  throw lastParseError;
}

function isInvalidLlmResponse(error: unknown): boolean {
  return error instanceof CodeloreError && error.code === "INVALID_LLM_RESPONSE";
}

function appendParseRetryFeedback(
  request: ChatCompletionInput,
  previousContent: string,
  error: unknown
): ChatCompletionInput {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof CodeloreError && typeof error.details?.cause === "string" ? error.details.cause : undefined;
  const feedback = [
    "Your previous response was rejected: it was not valid JSON or violated the required response structure.",
    `Error: ${message}`,
    cause ? `Cause: ${cause}` : "",
    "Return ONLY the corrected JSON object with the exact required structure. No prose, no markdown, no code fences.",
  ]
    .filter(Boolean)
    .join("\n");
  const retryMessages: ChatMessage[] = [
    ...request.messages,
    { role: "assistant", content: previousContent },
    { role: "user", content: feedback },
  ];
  // Keep responseSchema (and any future request fields): the retry must run
  // under the same output constraints as the original request.
  return { ...request, messages: retryMessages };
}

function errorForDebug(stage: GenerationDebugError["stage"], error: unknown): GenerationDebugError {
  return {
    stage,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof CodeloreError ? { code: error.code } : {}),
  };
}
