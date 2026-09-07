import { CodeloreError } from "../errors.js";
import { computeBlockFingerprint } from "../markdown/block-facets.js";
import { BLOCK_IDS, type BlockId } from "../markdown/block-ids.js";
import type { DocStateStorage } from "../storage/doc-state-storage.js";
import type {
  CodeEntity,
  CodeloreConfig,
  DocSection,
  DocState,
  DocStateBlock,
  DocStateSection,
  FilteredGeneratedBlock,
  GeneratedBlock,
  RewriteSectionInput,
} from "../types.js";
import { uniqueSorted } from "./helpers.js";

export interface NormalizedRewriteSectionInput {
  sectionId: string;
  blocks: Partial<Record<BlockId, GeneratedBlock>>;
  showFiltered: boolean;
}

export function groupRewritesByDoc(
  rewrites: NormalizedRewriteSectionInput[],
  sections: Record<string, DocSection>
): {
  byDoc: Map<string, NormalizedRewriteSectionInput[]>;
  docPathBySection: Map<string, string>;
} {
  const byDoc = new Map<string, NormalizedRewriteSectionInput[]>();
  const docPathBySection = new Map<string, string>();

  for (const rewrite of rewrites) {
    const section = sections[rewrite.sectionId];
    if (!section) {
      throw new CodeloreError("UNKNOWN_SECTION", `Unknown section id "${rewrite.sectionId}"`, {
        sectionId: rewrite.sectionId,
      });
    }
    docPathBySection.set(rewrite.sectionId, section.docPath);
    const group = byDoc.get(section.docPath) ?? [];
    group.push(rewrite);
    byDoc.set(section.docPath, group);
  }

  return { byDoc, docPathBySection };
}

export async function applyRewritesToDoc(
  docPath: string,
  rewrites: NormalizedRewriteSectionInput[],
  storage: DocStateStorage,
  entities: Record<string, CodeEntity>,
  config: CodeloreConfig,
  filteredBySection: Map<string, FilteredGeneratedBlock[]>
): Promise<void> {
  const state = await storage.loadDocState(docPath);
  if (!state) {
    throw new CodeloreError("UNKNOWN_DOC", `No state for ${docPath}`, { docPath });
  }
  for (const rewrite of rewrites) {
    const sectionState = state.sections[rewrite.sectionId];
    if (!sectionState) {
      throw new CodeloreError("UNKNOWN_SECTION", `Section "${rewrite.sectionId}" missing from state ${docPath}`, {
        sectionId: rewrite.sectionId,
        docPath,
      });
    }
    mergeGeneratedBlocksIntoSection(sectionState, rewrite, entities, config);
  }
  state.generatedAt = new Date().toISOString();
  await storage.renderAndPersist(state);
  collectFilteredBlocksForRewrites(state, rewrites, config, filteredBySection);
}

export function collectFilteredBlocksForRewrites(
  state: DocState,
  rewrites: NormalizedRewriteSectionInput[],
  config: CodeloreConfig,
  filteredBySection: Map<string, FilteredGeneratedBlock[]>
): void {
  for (const rewrite of rewrites) {
    const sectionState = state.sections[rewrite.sectionId];
    if (sectionState && rewrite.showFiltered) {
      filteredBySection.set(rewrite.sectionId, collectFilteredBlocksForResponse(sectionState, config, true));
    }
  }
}

export function mergeGeneratedBlocksIntoSection(
  sectionState: DocStateSection,
  rewrite: NormalizedRewriteSectionInput,
  entities: Record<string, CodeEntity>,
  config: CodeloreConfig
): void {
  for (const [blockId, generated] of Object.entries(rewrite.blocks) as Array<[BlockId, GeneratedBlock]>) {
    const fingerprint = computeBlockFingerprint(blockId, sectionState.owns, entities);
    const block: DocStateBlock = sectionState.blocks[blockId] ?? { body: "", rendered: false };
    block.body = generated.text.trim();
    // Stamp the canonical language the prose was written in; a later change of
    // docs.language marks the block stale via the `language` facet.
    block.language = config.docs.language;
    block.rendered = true; // tentative; final value set by storage.renderAndPersist via thresholds
    block.scores = {
      informativeness: generated.informativeness,
      novelty: generated.novelty,
      specificity: generated.specificity,
      novelFact: generated.novelFact,
    };
    if (fingerprint !== undefined) {
      block.fingerprint = fingerprint;
    }
    block.staleSince = undefined;
    block.staleReason = undefined;
    block.staleFacets = undefined;
    sectionState.blocks[blockId] = block;
    if (!sectionState.blockOrder.includes(blockId)) {
      sectionState.blockOrder.push(blockId);
    }
    if (!sectionState.allowedBlocks.includes(blockId)) {
      sectionState.allowedBlocks.push(blockId);
    }
  }

  // Re-derive structural metadata from current code so a rename/removal in the
  // owned entity's deps does not leave a stale (broken) reference in `depends`.
  const owner = sectionState.owns[0] ? entities[sectionState.owns[0]] : undefined;
  if (owner) {
    sectionState.depends = uniqueSorted([...owner.directDeps]);
    sectionState.usedBy = uniqueSorted([...owner.directUsages]);
    if (owner.type !== "file" && owner.signature) {
      sectionState.signature = owner.signature;
    }
  }

  updateSectionStatusForBlocks(sectionState);
}

export function updateSectionStatusForBlocks(sectionState: DocStateSection): void {
  // No review_needed guard here, unlike updateStatusFromBlocks: this runs only
  // after new block content was written (mergeGeneratedBlocksIntoSection). A
  // successful write resolves the reason review_needed was set, so it must clear.
  // The pipeline re-applies markReviewNeeded for blocks that stayed kept/contradicted,
  // so genuinely-unresolved sections come back to review_needed right after.
  const blocks = Object.values(sectionState.blocks);
  const anyStale = blocks.some((block) => block.staleSince !== undefined);
  const allStale = blocks.length > 0 && blocks.every((block) => block.staleSince !== undefined);
  sectionState.status = allStale ? "stale" : anyStale ? "normal" : "normal";
}

export function updateStatusFromBlocks(state: DocState): void {
  for (const section of Object.values(state.sections)) {
    if (section.status === "review_needed") {
      continue;
    }
    const blocks = Object.values(section.blocks);
    const allStale = blocks.length > 0 && blocks.every((block) => block.staleSince !== undefined);
    section.status = allStale ? "stale" : "normal";
  }
}

export function normalizeGeneratedRewrite(
  input: RewriteSectionInput,
  _config: CodeloreConfig
): NormalizedRewriteSectionInput {
  if (!input.generatedBlocks || Object.keys(input.generatedBlocks).length === 0) {
    throw new CodeloreError(
      "MISSING_GENERATED_BLOCKS",
      `Rewrite input for "${input.sectionId}" must include generatedBlocks.`,
      { sectionId: input.sectionId }
    );
  }

  const blocks: Partial<Record<BlockId, GeneratedBlock>> = {};
  for (const blockId of BLOCK_IDS) {
    const block = input.generatedBlocks[blockId];
    if (block) {
      blocks[blockId] = block;
    }
  }

  return {
    sectionId: input.sectionId,
    blocks,
    showFiltered: input.showFiltered ?? false,
  };
}

export function collectFilteredBlocksForResponse(
  sectionState: DocStateSection,
  config: CodeloreConfig,
  includeText: boolean
): FilteredGeneratedBlock[] {
  const result: FilteredGeneratedBlock[] = [];
  for (const blockId of sectionState.allowedBlocks) {
    const block = sectionState.blocks[blockId];
    if (!block?.scores || block.rendered) {
      continue;
    }
    const threshold = config.thresholds.perBlockScore?.[blockId] ?? config.thresholds.minScore;
    const finalScore = Math.min(block.scores.informativeness, block.scores.novelty, block.scores.specificity);
    result.push({
      blockId,
      novelFact: block.scores.novelFact,
      informativeness: block.scores.informativeness,
      novelty: block.scores.novelty,
      specificity: block.scores.specificity,
      finalScore,
      threshold,
      ...(includeText && block.body ? { text: block.body } : {}),
    });
  }
  return result;
}
