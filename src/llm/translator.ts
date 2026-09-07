import { CodeloreError } from "../errors.js";
import type { BlockId } from "../markdown/block-ids.js";
import { parseJsonObject } from "./json.js";
import type { ChatCompletionInput, ChatCompletionProvider } from "./provider.js";

export interface TranslateBlockInput {
  sectionId: string;
  blockId: BlockId;
  /** Canonical heading, given for context only — not part of the output. */
  heading: string;
  /** Canonical body to translate. */
  text: string;
}

export interface TranslateDocInput {
  /** Target language code (e.g. "en", "de"). */
  language: string;
  /** Target-language style rules for translated prose. */
  writingRules?: string[];
  /** Preferred target-language project terms. */
  terms?: string[];
  blocks: TranslateBlockInput[];
}

/** Translated bodies keyed by `${sectionId}\u0000${blockId}`. Blocks that failed validation are absent. */
export type TranslatedBlocks = Map<string, string>;

const DEFAULT_MAX_RETRIES = 2;
const CODE_SPAN = /`([^`\n]+)`/g;

function blockKey(sectionId: string, blockId: BlockId): string {
  return `${sectionId}\u0000${blockId}`;
}

function codeSpans(text: string): Set<string> {
  const spans = new Set<string>();
  for (const match of text.matchAll(CODE_SPAN)) {
    spans.add(match[1]);
  }
  return spans;
}

/** True when the text carries prose to translate, i.e. has letters outside its code spans. */
function hasTranslatableProse(text: string): boolean {
  return /\p{L}/u.test(text.replace(CODE_SPAN, " "));
}

/**
 * Deterministic guards on a translation:
 *  - every `code`-quoted span in the canonical body must appear verbatim in the
 *    translation and the translation may introduce none of its own (the canonical
 *    block already passed ref validation, so preserving its spans keeps every ref
 *    valid by construction);
 *  - a block with prose must not come back byte-identical to the source — that is
 *    the model echoing the source instead of translating it (a code-only block,
 *    with nothing to translate, may legitimately match).
 * Returns an explanation when a guard fails, or undefined when the block is clean.
 */
function blockViolation(canonical: string, translation: string): string | undefined {
  const want = codeSpans(canonical);
  const got = codeSpans(translation);
  const missing = [...want].filter((span) => !got.has(span));
  const unexpected = [...got].filter((span) => !want.has(span));
  if (missing.length > 0 || unexpected.length > 0) {
    return [
      "Code spans (text inside backticks) must match the source exactly.",
      missing.length > 0 ? `Missing: ${missing.map((span) => `\`${span}\``).join(", ")}.` : "",
      unexpected.length > 0 ? `Not in source: ${unexpected.map((span) => `\`${span}\``).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (canonical.trim() === translation.trim() && hasTranslatableProse(canonical)) {
    return "The text was returned unchanged. Translate the prose into the target language; keep only backtick spans verbatim.";
  }
  return undefined;
}

function systemPrompt(language: string): string {
  return [
    `You translate software documentation into the language with code "${language}".`,
    "Translate faithfully: do not add, remove, reinterpret, or reorder facts.",
    "Preserve all Markdown structure (lists, emphasis, line breaks).",
    "Keep every span inside backticks (identifiers, types, file paths, symbols) EXACTLY as in the source — never translate, transliterate, or alter text inside backticks.",
    "Return only valid JSON. Do not include Markdown fences.",
  ].join("\n");
}

function promptList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function translationGuidance(input: TranslateDocInput): string {
  const rules = promptList(input.writingRules);
  const terms = promptList(input.terms);
  return [
    rules.length > 0 ? ["Writing rules:", ...rules.map((rule) => `- ${rule}`)].join("\n") : "",
    terms.length > 0 ? ["Preferred target-language terms:", terms.join(", ")].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildTranslateRequest(input: TranslateDocInput): ChatCompletionInput {
  const blocks = input.blocks.map((block) => ({
    sectionId: block.sectionId,
    blockId: block.blockId,
    heading: block.heading,
    text: block.text,
  }));
  return {
    messages: [
      { role: "system", content: systemPrompt(input.language) },
      {
        role: "user",
        content: [
          `Translate the "text" of each block into language "${input.language}".`,
          translationGuidance(input),
          JSON.stringify({ blocks }, null, 2),
          "Return JSON with this exact shape, one entry per block:",
          '{"sections":{"<sectionId>":{"blocks":{"<blockId>":{"text":"..."}}}}}',
        ].join("\n\n"),
      },
    ],
  };
}

function buildRepairRequest(input: TranslateDocInput, violations: Map<string, string>): ChatCompletionInput {
  const blocks = input.blocks
    .filter((block) => violations.has(blockKey(block.sectionId, block.blockId)))
    .map((block) => ({
      sectionId: block.sectionId,
      blockId: block.blockId,
      sourceText: block.text,
      violation: violations.get(blockKey(block.sectionId, block.blockId)),
    }));
  return {
    messages: [
      { role: "system", content: systemPrompt(input.language) },
      {
        role: "user",
        content: [
          "These translations have problems. Re-translate each: fix the stated violation and keep every backtick span exactly as in sourceText.",
          translationGuidance(input),
          JSON.stringify({ blocks }, null, 2),
          "Return JSON with this exact shape, containing ONLY the listed blocks:",
          '{"sections":{"<sectionId>":{"blocks":{"<blockId>":{"text":"..."}}}}}',
        ].join("\n\n"),
      },
    ],
  };
}

function parseTranslateResponse(content: string): TranslatedBlocks {
  const root = parseJsonObject(content, "Translation response was not valid JSON");
  const sections = root.sections;
  const result: TranslatedBlocks = new Map();
  if (!sections || typeof sections !== "object") {
    return result;
  }
  for (const [sectionId, sectionValue] of Object.entries(sections as Record<string, unknown>)) {
    const blocks = (sectionValue as { blocks?: unknown })?.blocks;
    if (!blocks || typeof blocks !== "object") {
      continue;
    }
    for (const [blockId, blockValue] of Object.entries(blocks as Record<string, unknown>)) {
      const text = (blockValue as { text?: unknown })?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        result.set(blockKey(sectionId, blockId as BlockId), text.trim());
      }
    }
  }
  return result;
}

async function completeAndParseTranslation(
  provider: ChatCompletionProvider,
  request: ChatCompletionInput,
  maxRetries: number
): Promise<TranslatedBlocks> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const completion = await provider.complete(request);
      return parseTranslateResponse(completion.content);
    } catch (error) {
      lastError = error;
      // Only an invalid/unparseable response is worth another shot; transport
      // errors are already retried inside the provider.
      if (attempt >= maxRetries || !(error instanceof CodeloreError && error.code === "INVALID_LLM_RESPONSE")) {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Translates a doc's canonical block bodies into one language. Every requested
 * block is accounted for: a translated body must preserve the canonical block's
 * code spans and not be an untranslated echo, and a block the model omitted is
 * re-requested in the repair round. Blocks that still fail or are missing after
 * the one repair round are dropped (the caller keeps the previous translation, or
 * renders a "translation pending" callout). The translation is never verified
 * against the code — it inherits the canonical block's correctness.
 */
export async function translateBlocks(
  provider: ChatCompletionProvider,
  input: TranslateDocInput,
  options: { maxRetries?: number } = {}
): Promise<TranslatedBlocks> {
  if (input.blocks.length === 0) {
    return new Map();
  }
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sourceByKey = new Map(input.blocks.map((block) => [blockKey(block.sectionId, block.blockId), block.text]));

  const translated = await completeAndParseTranslation(provider, buildTranslateRequest(input), maxRetries);

  const violations = collectViolations(translated, sourceByKey);
  if (violations.size > 0) {
    const repaired = await completeAndParseTranslation(provider, buildRepairRequest(input, violations), maxRetries);
    for (const [key, text] of repaired) {
      translated.set(key, text);
    }
  }

  // Final gate: keep only blocks that pass every translation guard.
  const accepted: TranslatedBlocks = new Map();
  for (const [key, text] of translated) {
    const source = sourceByKey.get(key);
    if (source !== undefined && blockViolation(source, text) === undefined) {
      accepted.set(key, text);
    }
  }
  return accepted;
}

/**
 * Iterates every requested block (not just the ones that came back), so a block the
 * model omitted entirely is flagged as a violation and re-requested in the repair
 * round — without this, an incomplete batch response silently leaves blocks pending.
 */
function collectViolations(translated: TranslatedBlocks, sourceByKey: Map<string, string>): Map<string, string> {
  const violations = new Map<string, string>();
  for (const [key, source] of sourceByKey) {
    const text = translated.get(key);
    if (text === undefined) {
      violations.set(key, "This block was not returned. Translate it and include it in the output.");
      continue;
    }
    const violation = blockViolation(source, text);
    if (violation !== undefined) {
      violations.set(key, violation);
    }
  }
  return violations;
}

/**
 * True when a stored translation is not acceptable for its source — missing/extra
 * code spans, or an untranslated echo. Used to decide a translation needs (re)work
 * even when its source fingerprint still matches, so a bad translation self-heals
 * on the next run instead of being trusted forever.
 */
export function translationNeedsWork(source: string, translation: string): boolean {
  return blockViolation(source, translation) !== undefined;
}

export { blockKey as translationBlockKey };
