import { PROJECT_ID } from "../indexer/domain-entities.js";
import { computeBlockFingerprint } from "../markdown/block-facets.js";
import { DOC_STATE_VERSION } from "../storage/doc-state-storage.js";
import type { CodeEntity, DocState, DocStateBlock, DocStateSection } from "../types.js";
import { anchorForHeading, orderBlocks } from "./prepare-docs.js";

const PROJECT_DOC_PATH = "overview.codelore.md";
const PROJECT_HEADING = "Обзор проекта";

/**
 * Doc path for a domain: `docs/domains/<slug>.codelore.md`. Domains cut across
 * directories, so their docs are collected under one folder rather than colocated;
 * `docs/domains/` cannot collide with any source file's colocated `.codelore.md`.
 */
export function domainDocPath(slug: string): string {
  return `docs/domains/${slug}.codelore.md`;
}

export function projectDocPath(): string {
  return PROJECT_DOC_PATH;
}

/** The doc path for a domain/project tier entity, or undefined for a source-code entity. */
export function tierDocPathForEntity(entity: CodeEntity): string | undefined {
  if (entity.type === "project") {
    return projectDocPath();
  }
  if (entity.type === "domain") {
    return domainDocPath(entity.path);
  }
  return undefined;
}

function tierHeading(entity: CodeEntity): string {
  return entity.type === "project" ? PROJECT_HEADING : entity.name;
}

/** A single-section DocState for a domain or project entity, blocks empty (a skeleton). */
export function domainDocState(entity: CodeEntity, entities: Record<string, CodeEntity>): DocState {
  const docPath = tierDocPathForEntity(entity);
  if (docPath === undefined) {
    throw new Error(`domainDocState called with non-tier entity ${entity.id}`);
  }
  const allowed = entity.metadata?.allowedBlocks ?? [];
  const order = orderBlocks(allowed);
  const blocks: Record<string, DocStateBlock> = {};
  for (const blockId of order) {
    const fingerprint = computeBlockFingerprint(blockId, [entity.id], entities);
    blocks[blockId] = { body: "", rendered: false, ...(fingerprint !== undefined ? { fingerprint } : {}) };
  }
  const heading = tierHeading(entity);
  const section: DocStateSection = {
    heading,
    depth: 1,
    anchor: anchorForHeading(heading),
    owns: [entity.id],
    depends: [...entity.directDeps],
    usedBy: [...entity.directUsages],
    status: "normal",
    allowedBlocks: allowed,
    blockOrder: order,
    blocks,
  };
  return {
    version: DOC_STATE_VERSION,
    docPath,
    generatedAt: new Date().toISOString(),
    sectionOrder: [entity.id],
    sections: { [entity.id]: section },
  };
}

/** All tier skeletons keyed by doc path, from the injected domain/project entities. */
export function buildDomainSkeletons(entities: Record<string, CodeEntity>): Map<string, DocState> {
  const skeletons = new Map<string, DocState>();
  for (const entity of Object.values(entities)) {
    if (entity.type === "domain" || entity.id === PROJECT_ID) {
      skeletons.set(tierDocPathForEntity(entity) as string, domainDocState(entity, entities));
    }
  }
  return skeletons;
}
