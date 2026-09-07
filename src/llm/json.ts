import { CodeloreError } from "../errors.js";

const OUTER_FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

function stripOuterFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(OUTER_FENCE);
  return match ? match[1].trim() : trimmed;
}

// Three narrow replacements for LLM-emitted JSON-invalid escapes observed in
// production on this project's default provider (aitunnel/deepseek-v4-flash).
// Without these the pipeline fails on nearly every request. Anything beyond
// these three is handled by the retry-with-feedback loop, not by widening
// this list.
//   \`  → `      template-literal backtick escape; LLM meant a bare backtick
//   \$  → $      template-literal dollar escape; LLM meant a bare dollar
//   \.  → \\.    regex literal dot; LLM meant a literal "\." in the regex,
//                preserve the backslash so JSON.parse keeps it
function repairKnownLlmEscapes(json: string): string {
  return json
    .replace(/\\`/g, "`")
    .replace(/\\\$/g, "$")
    .replace(/(?<!\\)\\\./g, "\\\\.");
}

export function parseJsonObject(content: string, message: string): Record<string, unknown> {
  const stripped = stripOuterFence(content);
  // Valid JSON must never go through the escape repair: a doc that *describes*
  // the \` \$ \. patterns contains them as valid \\-escapes, and repairing
  // those corrupts the response.
  try {
    return asJsonObject(JSON.parse(stripped) as unknown);
  } catch {
    // fall through to the repaired attempt
  }
  try {
    return asJsonObject(JSON.parse(repairKnownLlmEscapes(stripped)) as unknown);
  } catch (error) {
    throw new CodeloreError("INVALID_LLM_RESPONSE", message, {
      cause: error instanceof Error ? error.message : String(error),
      response: content.slice(0, 1000),
    });
  }
}

function asJsonObject(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not an object");
  }
  return parsed as Record<string, unknown>;
}

export function readOptionalString(raw: Record<string, unknown>, field: string, subject: string): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CodeloreError("INVALID_LLM_RESPONSE", `${subject} field "${field}" must be a string`);
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}
