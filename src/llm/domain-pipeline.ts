import { CodeloreError } from "../errors.js";
import type { BlockId } from "../markdown/block-ids.js";
import { buildVerifyRequest, type ContradictedClaim, parseVerifyResponse } from "./doc-verifier.js";
import {
  type BuildDomainWriteRequestInput,
  buildDomainWriteRequest,
  parseDomainWriteResponse,
} from "./domain-writer.js";
import type { WrittenBlock } from "./file-writer.js";
import type { ChatCompletionProvider } from "./provider.js";

export interface DomainGenerationResult {
  blocks: Partial<Record<BlockId, WrittenBlock>>;
  /** Blocks the writer produced but the verifier contradicted against the member docs. */
  dropped: ContradictedClaim[];
}

/**
 * Generates the prose blocks of one tier doc (a domain or the project): the writer
 * summarizes the member docs, then the verifier fact-checks each block against the
 * same member-doc text and any statement it contradicts is dropped. A tier doc has
 * no source of its own, so its ground truth is the verified member docs — the
 * verify pass reuses the doc verifier with the member prose standing in for source.
 */
export async function generateDomainDoc(args: {
  input: BuildDomainWriteRequestInput;
  /** Concatenated member-doc prose — the ground truth the blocks are checked against. */
  memberEvidence: string;
  provider: ChatCompletionProvider;
  verifyProvider: ChatCompletionProvider;
}): Promise<DomainGenerationResult> {
  const { input, memberEvidence, provider, verifyProvider } = args;
  const sectionId = input.tier.id;

  const written = await writeWithRetries(input, provider, DOMAIN_WRITE_MAX_RETRIES);
  const blocks = written[sectionId] ?? {};
  if (blockEntries(blocks).length === 0) {
    return { blocks, dropped: [] };
  }

  let contradicted = await verifyBlocks(blocks, memberEvidence, sectionId, verifyProvider);
  // Fact-repair, then recheck only the repaired blocks: a summary legitimately
  // abstracts its members, so a flagged block is more often loose wording than a
  // real contradiction. Rewriting against the member docs salvages it; only what
  // stays contradicted after the rewrite is dropped.
  if (contradicted.length > 0) {
    const repaired = await repairContradictedBlocks(input, blocks, contradicted, provider);
    for (const [blockId, block] of Object.entries(repaired) as Array<[BlockId, WrittenBlock]>) {
      blocks[blockId] = block;
    }
    const repairedIds = new Set(Object.keys(repaired) as BlockId[]);
    const rechecked = blockSubset(blocks, repairedIds);
    contradicted = await verifyBlocks(rechecked, memberEvidence, sectionId, verifyProvider);
  }

  const contradictedIds = new Set(contradicted.map((claim) => claim.blockId));
  const kept: Partial<Record<BlockId, WrittenBlock>> = {};
  for (const [blockId, block] of blockEntries(blocks)) {
    if (!contradictedIds.has(blockId)) {
      kept[blockId] = block;
    }
  }
  return { blocks: kept, dropped: contradicted };
}

/** Fact-checks the given blocks against the member-doc text; returns the contradicted ones. */
async function verifyBlocks(
  blocks: Partial<Record<BlockId, WrittenBlock>>,
  memberEvidence: string,
  sectionId: string,
  verifyProvider: ChatCompletionProvider
): Promise<ContradictedClaim[]> {
  const list = blockEntries(blocks);
  if (list.length === 0) {
    return [];
  }
  const request = buildVerifyRequest({
    sections: [
      {
        sectionId,
        entityId: sectionId,
        source: memberEvidence,
        blocks: list.map(([blockId, block]) => ({ blockId, text: block.text })),
      },
    ],
    dependencyDocs: [],
  });
  const completion = await verifyProvider.complete(request);
  return parseVerifyResponse(completion.content, [
    {
      sectionId,
      entityId: sectionId,
      source: memberEvidence,
      blocks: list.map(([blockId]) => ({ blockId, text: "" })),
    },
  ]);
}

/** Asks the writer to rewrite only the contradicted blocks against the member docs; returns the rewritten ones. */
async function repairContradictedBlocks(
  input: BuildDomainWriteRequestInput,
  blocks: Partial<Record<BlockId, WrittenBlock>>,
  contradicted: ContradictedClaim[],
  provider: ChatCompletionProvider
): Promise<Partial<Record<BlockId, WrittenBlock>>> {
  const flaggedIds = [...new Set(contradicted.map((claim) => claim.blockId))];
  const violations = contradicted
    .map((claim) => `- ${claim.blockId}: "${claim.statement}" — ${claim.evidence}`)
    .join("\n");
  const previous = JSON.stringify({ sections: { [input.tier.id]: { blocks: currentBlocksForPrompt(blocks) } } });
  const base = buildDomainWriteRequest(input);
  const request = {
    ...base,
    messages: [
      ...base.messages,
      { role: "assistant" as const, content: previous },
      {
        role: "user" as const,
        content: [
          "These statements are contradicted by the member docs (the only ground truth):",
          violations,
          `Rewrite ONLY these blocks so every statement is supported by the member docs: ${flaggedIds.join(", ")}.`,
          "Drop any claim you cannot support. Return JSON in the same shape with ONLY those block keys under the section.",
        ].join("\n"),
      },
    ],
  };
  const completion = await provider.complete(request);
  try {
    const parsed = parseDomainWriteResponse(completion.content, input, { requireCompleteness: false });
    return blockSubset(parsed[input.tier.id] ?? {}, new Set(flaggedIds));
  } catch {
    // A malformed repair is not fatal: fall back to dropping the flagged blocks.
    return {};
  }
}

function currentBlocksForPrompt(blocks: Partial<Record<BlockId, WrittenBlock>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [blockId, block] of blockEntries(blocks)) {
    out[blockId] = {
      text: block.text,
      refs: block.refs,
      novelFact: block.novelFact,
      informativeness: block.informativeness,
      novelty: block.novelty,
      specificity: block.specificity,
    };
  }
  return out;
}

function blockSubset(
  blocks: Partial<Record<BlockId, WrittenBlock>>,
  ids: Set<BlockId>
): Partial<Record<BlockId, WrittenBlock>> {
  const out: Partial<Record<BlockId, WrittenBlock>> = {};
  for (const [blockId, block] of blockEntries(blocks)) {
    if (ids.has(blockId)) {
      out[blockId] = block;
    }
  }
  return out;
}

/** Providers without json_schema enforcement (deepseek v4-pro) can emit trailing junk; retry with the parse error as feedback. */
const DOMAIN_WRITE_MAX_RETRIES = 3;

async function writeWithRetries(
  input: BuildDomainWriteRequestInput,
  provider: ChatCompletionProvider,
  maxRetries: number
) {
  const base = buildDomainWriteRequest(input);
  let request = base;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const completion = await provider.complete(request);
    try {
      return parseDomainWriteResponse(completion.content, input);
    } catch (error) {
      if (!(error instanceof CodeloreError) || error.code !== "INVALID_LLM_RESPONSE") {
        throw error;
      }
      lastError = error;
      request = {
        ...base,
        messages: [
          ...base.messages,
          { role: "assistant", content: completion.content },
          {
            role: "user",
            content: `Your previous response was invalid: ${error.message}. Return ONLY the corrected JSON object, same shape, nothing before or after it, no fences.`,
          },
        ],
      };
    }
  }
  throw lastError;
}

function blockEntries(blocks: Partial<Record<BlockId, WrittenBlock>>): Array<[BlockId, WrittenBlock]> {
  return Object.entries(blocks).filter(([, block]) => block !== undefined) as Array<[BlockId, WrittenBlock]>;
}
