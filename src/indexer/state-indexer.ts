import { CodeloreError } from "../errors.js";
import type { BlockId } from "../markdown/block-ids.js";
import { DocStateStorage } from "../storage/doc-state-storage.js";
import type { CodeloreConfig, DocBlock, DocIndex, DocSection, DocStateBlock, DocStateSection } from "../types.js";
import { INDEX_VERSION } from "../types.js";

export async function buildDocIndex(
  config: CodeloreConfig,
  stateStorage: DocStateStorage = new DocStateStorage(config)
): Promise<DocIndex> {
  const docPaths = (await stateStorage.listDocStates()).sort();
  const sections: DocIndex["sections"] = {};
  const fileToSections: DocIndex["fileToSections"] = {};
  const entityToSections: DocIndex["entityToSections"] = {};

  for (const docPath of docPaths) {
    const state = await stateStorage.loadDocState(docPath);
    if (!state) {
      continue;
    }
    fileToSections[docPath] = [];

    for (const sectionId of state.sectionOrder) {
      const sectionState = state.sections[sectionId];
      if (!sectionState) {
        continue;
      }
      addSectionToIndex(sectionId, docPath, sectionState, config, sections, fileToSections, entityToSections);
    }
  }

  for (const sectionIds of Object.values(entityToSections)) {
    sectionIds.sort();
  }

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    rootDir: config.rootDir,
    sections,
    fileToSections,
    entityToSections,
  };
}

/**
 * In-place incremental update of a DocIndex for a set of doc paths whose JSON
 * state changed (block edits, status flips, stale marks). Source code is
 * untouched by those mutations, so the code index stays valid and only the
 * doc-derived index needs patching — avoiding a full-project ts-morph reparse.
 * Each doc path's contribution is fully replaced, so added/changed/removed
 * sections are all handled.
 */
export async function patchDocIndexPaths(
  index: DocIndex,
  config: CodeloreConfig,
  stateStorage: DocStateStorage,
  docPaths: string[]
): Promise<void> {
  const touchedEntities = new Set<string>();

  for (const docPath of docPaths) {
    for (const sectionId of index.fileToSections[docPath] ?? []) {
      const section = index.sections[sectionId];
      if (section) {
        for (const ownedEntity of section.owns) {
          const bucket = index.entityToSections[ownedEntity];
          if (!bucket) {
            continue;
          }
          const remaining = bucket.filter((id) => id !== sectionId);
          if (remaining.length > 0) {
            index.entityToSections[ownedEntity] = remaining;
          } else {
            delete index.entityToSections[ownedEntity];
          }
          touchedEntities.add(ownedEntity);
        }
      }
      delete index.sections[sectionId];
    }
    delete index.fileToSections[docPath];

    const state = await stateStorage.loadDocState(docPath);
    if (!state) {
      continue;
    }
    index.fileToSections[docPath] = [];
    for (const sectionId of state.sectionOrder) {
      const sectionState = state.sections[sectionId];
      if (!sectionState) {
        continue;
      }
      addSectionToIndex(
        sectionId,
        docPath,
        sectionState,
        config,
        index.sections,
        index.fileToSections,
        index.entityToSections
      );
      for (const ownedEntity of sectionState.owns) {
        touchedEntities.add(ownedEntity);
      }
    }
  }

  for (const entity of touchedEntities) {
    index.entityToSections[entity]?.sort();
  }
  index.generatedAt = new Date().toISOString();
}

function addSectionToIndex(
  sectionId: string,
  docPath: string,
  sectionState: DocStateSection,
  config: CodeloreConfig,
  sections: DocIndex["sections"],
  fileToSections: DocIndex["fileToSections"],
  entityToSections: DocIndex["entityToSections"]
): void {
  if (sections[sectionId]) {
    throw new CodeloreError("DUPLICATE_SECTION", `Duplicate doc section id "${sectionId}" in ${docPath}`, {
      sectionId,
      docPath,
    });
  }
  const section = sectionFromState(sectionId, docPath, sectionState, config);
  sections[sectionId] = section;
  fileToSections[docPath].push(sectionId);

  for (const ownedEntity of section.owns) {
    const existing = entityToSections[ownedEntity] ?? [];
    existing.push(sectionId);
    entityToSections[ownedEntity] = existing;
  }
}

function sectionFromState(
  sectionId: string,
  docPath: string,
  state: DocStateSection,
  config: CodeloreConfig
): DocSection {
  const blocks: DocBlock[] = state.blockOrder.map((blockId) =>
    blockFromState(blockId, state.depth + 1, state.blocks[blockId], config)
  );
  const blockFingerprints: Record<string, string> = {};
  for (const [blockId, block] of Object.entries(state.blocks)) {
    if (block.fingerprint !== undefined) {
      blockFingerprints[blockId] = block.fingerprint;
    }
  }
  return {
    id: sectionId,
    docPath,
    heading: state.heading,
    depth: state.depth,
    anchor: state.anchor,
    owns: state.owns,
    depends: state.depends,
    usedBy: state.usedBy,
    status: state.status,
    allowedBlocks: state.allowedBlocks,
    blockFingerprints,
    blocks,
    ...(state.depDocsFingerprint !== undefined ? { depDocsFingerprint: state.depDocsFingerprint } : {}),
    ...(state.memberDocsFingerprint !== undefined ? { memberDocsFingerprint: state.memberDocsFingerprint } : {}),
  };
}

function blockFromState(
  blockId: BlockId,
  depth: number,
  block: DocStateBlock | undefined,
  config: CodeloreConfig
): DocBlock {
  return {
    id: blockId,
    heading: config.docs.blockHeadings[blockId] ?? blockId,
    depth,
    body: block?.body ?? "",
    rendered: block?.rendered ?? false,
    language: block?.language,
    staleSince: block?.staleSince,
    staleReason: block?.staleReason,
    staleFacets: block?.staleFacets,
    scores: block?.scores,
  };
}
