import type { BlockId } from "../markdown/block-ids.js";
import type { CodeEntity, DocState, DocStateSection } from "../types.js";

/**
 * Prune doc state to match the current code: drop sections whose owning entity
 * no longer exists, and drop blocks the entity's block-inclusion no longer
 * allows (e.g. a method shrank so changeGuide is no longer warranted). Returns
 * true if anything was removed. The caller persists or deletes the doc.
 */
export function reconcileDocStateWithCode(state: DocState, entities: Record<string, CodeEntity>): boolean {
  let changed = false;
  for (const sectionId of [...state.sectionOrder]) {
    const section = state.sections[sectionId];
    if (!section) {
      continue;
    }
    const ownerId = section.owns[0];
    const owner = ownerId ? entities[ownerId] : undefined;
    if (!owner) {
      delete state.sections[sectionId];
      state.sectionOrder = state.sectionOrder.filter((id) => id !== sectionId);
      changed = true;
      continue;
    }
    if (pruneDisallowedBlocks(section, owner)) {
      changed = true;
    }
  }
  return changed;
}

function pruneDisallowedBlocks(section: DocStateSection, owner: CodeEntity): boolean {
  const allowed = owner.metadata?.allowedBlocks;
  // No metadata means block-inclusion never ran for this entity; pruning here
  // would wrongly strip every block, so leave the section untouched.
  if (!allowed) {
    return false;
  }
  const allowedSet = new Set<BlockId>(allowed);
  let changed = false;
  for (const blockId of Object.keys(section.blocks)) {
    if (!allowedSet.has(blockId as BlockId)) {
      delete section.blocks[blockId];
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  section.blockOrder = section.blockOrder.filter((id) => allowedSet.has(id));
  section.allowedBlocks = section.allowedBlocks.filter((id) => allowedSet.has(id));
  return true;
}
