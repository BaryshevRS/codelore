import { collectDomainMemberEvidence, domainMemberFingerprint } from "../domains/member-evidence.js";
import { collectDependencyDocs, dependencyDocsFingerprint, PROPAGATING_BLOCKS } from "../llm/file-pipeline.js";
import {
  BLOCK_FACETS,
  computeBlockFingerprint,
  diffFacetHashes,
  parseBlockFingerprintValue,
} from "../markdown/block-facets.js";
import type { BlockId } from "../markdown/block-ids.js";
import type {
  CodeEntity,
  DocSection,
  Facet,
  ProjectIndex,
  RefreshStaleDocsResult,
  RefreshStaleMode,
  RefreshStaleScope,
  RewriteContextBundle,
  StaleBlockInfo,
} from "../types.js";
import { isKnownBlockId, summarizeCodeEntity } from "./helpers.js";

export function targetBlocksFromTombstones(
  tombstoned: Array<{ sectionId: string; blockId: string }>
): Map<string, BlockId[]> {
  const targets = new Map<string, BlockId[]>();
  for (const entry of tombstoned) {
    addTargetBlock(targets, entry.sectionId, entry.blockId);
  }
  return targets;
}

export function addTargetBlock(targets: Map<string, BlockId[]>, sectionId: string, blockId: string): void {
  if (!isKnownBlockId(blockId)) {
    return;
  }
  const existing = targets.get(sectionId) ?? [];
  if (!existing.includes(blockId)) {
    targets.set(sectionId, [...existing, blockId]);
  }
}

export function filterSectionsByScope(
  sections: DocSection[],
  scope: RefreshStaleScope | undefined,
  entities: Record<string, CodeEntity>
): DocSection[] {
  if (!scope || (!scope.sectionIds?.length && !scope.files?.length && !scope.paths?.length)) {
    return sections;
  }
  const sectionIds = new Set(scope.sectionIds ?? []);
  const files = new Set(scope.files ?? []);
  const paths = scope.paths ?? [];
  return sections.filter((section) => {
    if (sectionIds.has(section.id)) {
      return true;
    }
    const ownedPaths = section.owns
      .map((ownId) => entities[ownId]?.path ?? sourcePathFromEntityId(ownId))
      .filter((path): path is string => !!path);
    if (ownedPaths.some((path) => files.has(path))) {
      return true;
    }
    return paths.some((prefix) => ownedPaths.some((path) => path === prefix || path.startsWith(`${prefix}/`)));
  });
}

export function sourcePathFromEntityId(entityId: string): string | undefined {
  if (entityId.startsWith("file:")) {
    return entityId.slice("file:".length);
  }
  if (!entityId.startsWith("symbol:")) {
    return undefined;
  }
  const path = entityId.slice("symbol:".length).split("#")[0];
  return path.length > 0 ? path : undefined;
}

/**
 * A section generated against dependency docs goes stale when those docs
 * change: the cascade that pushes leaf updates up the dependency graph.
 */
export function collectDepDocStaleBlocks(sections: DocSection[], index: ProjectIndex): StaleBlockInfo[] {
  const stale: StaleBlockInfo[] = [];
  const fingerprintByFile = new Map<string, string>();
  for (const section of sections) {
    if (section.depDocsFingerprint === undefined) {
      continue;
    }
    const ownerId = section.owns[0];
    const file = ownerId ? index.code.entities[ownerId]?.path : undefined;
    if (!file) {
      continue;
    }
    let current = fingerprintByFile.get(file);
    if (current === undefined) {
      current = dependencyDocsFingerprint(collectDependencyDocs(index, [file]));
      fingerprintByFile.set(file, current);
    }
    if (current === section.depDocsFingerprint) {
      continue;
    }
    for (const block of section.blocks) {
      if (!isKnownBlockId(block.id) || block.staleSince !== undefined || block.body.trim() === "") {
        continue;
      }
      // Propagating blocks are generated without dependency docs, so they cannot
      // drift by depDocs — only terminal blocks consume them.
      if (PROPAGATING_BLOCKS.includes(block.id)) {
        continue;
      }
      stale.push({
        sectionId: section.id,
        docPath: section.docPath,
        blockId: block.id,
        blockHeading: block.heading,
        changedFacets: ["depDocs"],
        drift: "facet_changed",
      });
    }
  }
  return stale;
}

/**
 * A tier (domain/project) block goes stale when the member docs it summarizes
 * change: the cascade that pushes a file-doc edit up into its domain doc, and a
 * domain-doc edit up into the project overview. Recomputes each tier section's
 * member-doc fingerprint and flags its blocks when the stored one diverges — the
 * same deterministic mechanism as depDocs, one tier higher.
 */
export function collectMemberDocStaleBlocks(sections: DocSection[], index: ProjectIndex): StaleBlockInfo[] {
  const stale: StaleBlockInfo[] = [];
  for (const section of sections) {
    if (section.memberDocsFingerprint === undefined) {
      continue;
    }
    const entity = index.code.entities[section.owns[0] ?? ""];
    if (!entity) {
      continue;
    }
    const current = domainMemberFingerprint(collectDomainMemberEvidence(entity, index));
    if (current === section.memberDocsFingerprint) {
      continue;
    }
    for (const block of section.blocks) {
      if (!isKnownBlockId(block.id) || block.staleSince !== undefined || block.body.trim() === "") {
        continue;
      }
      stale.push({
        sectionId: section.id,
        docPath: section.docPath,
        blockId: block.id,
        blockHeading: block.heading,
        changedFacets: ["memberDocs"],
        drift: "facet_changed",
      });
    }
  }
  return stale;
}

/**
 * A block goes stale when the canonical `docs.language` changes: its prose was
 * stamped with the language it was written in, and a different canonical language
 * means the body is now in the wrong language. Only blocks carrying a stamp that
 * differs from the current canonical are flagged — blocks generated before
 * stamping (no stamp) or written in the current language are left untouched.
 */
export function collectLanguageStaleBlocks(
  sections: DocSection[],
  canonicalLanguage: string | undefined
): StaleBlockInfo[] {
  if (canonicalLanguage === undefined) {
    return [];
  }
  const stale: StaleBlockInfo[] = [];
  for (const section of sections) {
    for (const block of section.blocks) {
      if (!isKnownBlockId(block.id) || block.staleSince !== undefined || block.body.trim() === "") {
        continue;
      }
      if (block.language === undefined || block.language === canonicalLanguage) {
        continue;
      }
      stale.push({
        sectionId: section.id,
        docPath: section.docPath,
        blockId: block.id,
        blockHeading: block.heading,
        changedFacets: ["language"],
        drift: "facet_changed",
      });
    }
  }
  return stale;
}

/** The AST, depDocs, and language passes can flag the same block; union their facets instead of letting the later entry win. */
export function mergeStaleBlocks(...passes: StaleBlockInfo[][]): StaleBlockInfo[] {
  const byBlock = new Map<string, StaleBlockInfo>();
  for (const entry of passes.flat()) {
    const key = `${entry.sectionId}\u0000${entry.blockId}`;
    const existing = byBlock.get(key);
    if (!existing) {
      byBlock.set(key, entry);
      continue;
    }
    existing.changedFacets = [...new Set([...existing.changedFacets, ...entry.changedFacets])];
  }
  return [...byBlock.values()];
}

export function collectStaleBlocks(sections: DocSection[], entities: Record<string, CodeEntity>): StaleBlockInfo[] {
  const stale: StaleBlockInfo[] = [];
  for (const section of sections) {
    const presentOwns = section.owns.filter((id) => entities[id]);
    if (presentOwns.length === 0) {
      stale.push(...deletedOwnedEntityBlocks(section));
      continue;
    }
    for (const block of section.blocks) {
      const info = staleBlockInfoFor(section, block, presentOwns, entities);
      if (info) {
        stale.push(info);
      }
    }
  }
  return stale;
}

export function collectTombstonedBlocks(
  sections: DocSection[],
  entities: Record<string, CodeEntity>
): StaleBlockInfo[] {
  const tombstoned: StaleBlockInfo[] = [];
  for (const section of sections) {
    const presentOwns = section.owns.filter((id) => entities[id]);
    if (presentOwns.length === 0) {
      tombstoned.push(...deletedOwnedEntityBlocks(section, { tombstonedOnly: true }));
      continue;
    }
    for (const block of section.blocks) {
      const info = tombstonedBlockInfoFor(section, block);
      if (info) {
        tombstoned.push(info);
      }
    }
  }
  return tombstoned;
}

export function deletedOwnedEntityBlocks(
  section: DocSection,
  options: { tombstonedOnly?: boolean } = {}
): StaleBlockInfo[] {
  const stale: StaleBlockInfo[] = [];
  for (const block of section.blocks) {
    if (!isKnownBlockId(block.id) || block.body.trim() === "") {
      continue;
    }
    if ((block.staleSince !== undefined) !== (options.tombstonedOnly ?? false)) {
      continue;
    }
    stale.push({
      sectionId: section.id,
      docPath: section.docPath,
      blockId: block.id,
      blockHeading: block.heading,
      changedFacets: ["owned"],
      drift: "owned_entity_deleted",
    });
  }
  return stale;
}

export function staleReasonFor(entry: StaleBlockInfo): string {
  if (entry.drift === "owned_entity_deleted") {
    return "owned_entity_deleted";
  }
  return entry.changedFacets.length === 1 ? `${entry.changedFacets[0]}_changed` : "code_changed";
}

export function staleBlockInfoFor(
  section: DocSection,
  block: DocSection["blocks"][number],
  presentOwns: string[],
  entities: Record<string, CodeEntity>
): StaleBlockInfo | undefined {
  if (!isKnownBlockId(block.id)) {
    return undefined;
  }
  // An empty block has no documentation to go stale.
  if (block.staleSince !== undefined || block.body.trim() === "") {
    return undefined;
  }
  const currentValue = computeBlockFingerprint(block.id, presentOwns, entities);
  if (currentValue === undefined) {
    return undefined;
  }
  const storedValue = section.blockFingerprints[block.id];
  if (storedValue === undefined || storedValue === currentValue) {
    return undefined;
  }
  const changedFacets = diffFacetHashes(
    parseBlockFingerprintValue(storedValue),
    parseBlockFingerprintValue(currentValue)
  );
  const suspectFacets: Facet[] = changedFacets.length > 0 ? changedFacets : [...BLOCK_FACETS[block.id]];
  return {
    sectionId: section.id,
    docPath: section.docPath,
    blockId: block.id,
    blockHeading: block.heading,
    changedFacets: suspectFacets,
    drift: "facet_changed",
  };
}

export function tombstonedBlockInfoFor(
  section: DocSection,
  block: DocSection["blocks"][number]
): StaleBlockInfo | undefined {
  if (!isKnownBlockId(block.id) || block.staleSince === undefined || block.body.trim() === "") {
    return undefined;
  }
  return {
    sectionId: section.id,
    docPath: section.docPath,
    blockId: block.id,
    blockHeading: block.heading,
    changedFacets: block.staleFacets ?? [...BLOCK_FACETS[block.id]],
    drift: "tombstoned",
  };
}

export function buildRewriteContextBundle(entry: StaleBlockInfo, index: ProjectIndex): RewriteContextBundle {
  const section = index.docs.sections[entry.sectionId];
  const block = section?.blocks.find((item) => item.id === entry.blockId);
  const owns = (section?.owns ?? [])
    .map((id) => index.code.entities[id])
    .filter((entity): entity is CodeEntity => Boolean(entity))
    .map(summarizeCodeEntity);
  return {
    sectionId: entry.sectionId,
    docPath: entry.docPath,
    blockId: entry.blockId,
    blockHeading: entry.blockHeading,
    targets: [entry.blockId as BlockId],
    changedFacets: entry.changedFacets,
    currentText: block?.body ?? "",
    owns,
    reason: `${entry.changedFacets.join(", ")} changed for ${owns.map((entity) => entity.name).join(", ")}`,
  };
}

export function refreshStaleResult(
  mode: RefreshStaleMode,
  stale: StaleBlockInfo[],
  tombstoned: StaleBlockInfo[],
  appliedTombstones: Array<{ sectionId: string; blockId: string; docPath: string }> = [],
  rewritePlan?: RewriteContextBundle[]
): RefreshStaleDocsResult {
  return {
    mode,
    summary: {
      stale: stale.length,
      tombstoned: tombstoned.length,
      appliedTombstones: appliedTombstones.length,
    },
    stale,
    tombstoned,
    appliedTombstones: mode === "tombstone" ? appliedTombstones : undefined,
    rewritePlan,
  };
}
