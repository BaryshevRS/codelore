import { type DomainMap, fileToDomainSlug } from "../domains/domain-map.js";
import { buildDomainDag } from "../graph/domain-dag.js";
import type { BlockId } from "../markdown/block-ids.js";
import type { CodeEntity, CodeIndex, EntityFacets, EntityMetadata } from "../types.js";
import { sha256 } from "../utils/hash.js";

/** Synthetic-entity id prefixes for the second and third documentation tiers. */
export const DOMAIN_ID_PREFIX = "domain:";
export const PROJECT_ID = "project:";

/**
 * Blocks a domain doc carries. A domain summarises a subsystem from its members'
 * finished docs, so the code-level blocks (invariants, changeGuide) do not apply;
 * what remains is why it exists, what it holds, what it depends on, how work flows
 * through it, and what it deliberately leaves out.
 */
export const DOMAIN_BLOCKS: BlockId[] = ["purpose", "responsibility", "dependencies", "workflows", "limitations"];

/** Blocks the project overview carries — one tier up, no dependency block (it stands over everything). */
export const PROJECT_BLOCKS: BlockId[] = ["purpose", "responsibility", "workflows", "limitations"];

/** A synthetic tier entity (a domain or the project), not a source-code entity. */
export function isDomainTierEntity(entity: Pick<CodeEntity, "type">): boolean {
  return entity.type === "domain" || entity.type === "project";
}

/** A real source-code entity (file/function/method/class), the unit of the file-doc pipeline. */
export function isSourceCodeEntity(entity: Pick<CodeEntity, "type">): boolean {
  return !isDomainTierEntity(entity);
}

export function domainIdFor(slug: string): string {
  return `${DOMAIN_ID_PREFIX}${slug}`;
}

function synthFacets(deps: string[], usages: string[], placement: string): EntityFacets {
  return {
    signature: sha256(""),
    body: sha256(""),
    deps: sha256([...deps].sort().join("|")),
    usage: sha256([...usages].sort().join("|")),
    placement: sha256(placement),
  };
}

function synthMetadata(allowedBlocks: BlockId[]): EntityMetadata {
  return {
    statementCount: 0,
    inDegree: 0,
    hasSideEffects: false,
    isEntryPoint: false,
    imports: { specifiers: [] },
    globals: { used: [] },
    weight: 1,
    role: "full_page",
    allowedBlocks,
    skippedBlocks: [],
  };
}

/** The `file:` id for a source path, from the index (falls back to the conventional form). */
function fileIdFor(code: CodeIndex, filePath: string): string {
  const ids = code.fileToEntities[filePath];
  return ids?.find((id) => id.startsWith("file:")) ?? `file:${filePath}`;
}

/**
 * Synthetic `domain:` and `project:` entities derived from the code index and the
 * domain map. Each domain owns its slug; `directDeps` are the member `file:` ids
 * (only those present in the index) plus the `domain:` ids it depends on (so the
 * deps facet flips when membership or a cross-domain edge changes, and the doc's
 * skeleton can list both), and `directUsages` are the domains that depend on it.
 * The project entity owns everything: its deps are every domain id. These carry
 * synthetic facets so block fingerprinting works, and explicit `allowedBlocks` so
 * reconcile does not prune them by AST metrics they do not have. A domain whose
 * members are all absent from the index is skipped.
 */
export function buildDomainEntities(code: CodeIndex, map: DomainMap): Record<string, CodeEntity> {
  const fileToDomain = fileToDomainSlug(map);
  const dag = buildDomainDag(code, fileToDomain);

  const dependents = new Map<string, Set<string>>();
  for (const slug of dag.keys()) {
    dependents.set(slug, new Set());
  }
  for (const [from, tos] of dag) {
    for (const to of tos) {
      dependents.get(to)?.add(from);
    }
  }

  const entities: Record<string, CodeEntity> = {};
  const domainIds: string[] = [];
  for (const domain of map.domains) {
    const memberFiles = domain.files
      .filter((file) => code.fileToEntities[file] !== undefined)
      .map((file) => fileIdFor(code, file))
      .sort();
    if (memberFiles.length === 0) {
      continue;
    }
    const id = domainIdFor(domain.slug);
    domainIds.push(id);
    const depDomains = [...(dag.get(domain.slug) ?? [])].sort().map(domainIdFor);
    const usedByDomains = [...(dependents.get(domain.slug) ?? [])].sort().map(domainIdFor);
    const directDeps = [...memberFiles, ...depDomains];
    entities[id] = {
      id,
      type: "domain",
      path: domain.slug,
      name: domain.name,
      signature: "",
      range: { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 },
      directDeps,
      directUsages: usedByDomains,
      contentHash: sha256(directDeps.join("|")),
      facets: synthFacets(directDeps, usedByDomains, domain.slug),
      metadata: synthMetadata(DOMAIN_BLOCKS),
    };
  }

  if (domainIds.length === 0) {
    return entities;
  }

  const sortedDomainIds = domainIds.sort();
  entities[PROJECT_ID] = {
    id: PROJECT_ID,
    type: "project",
    path: ".",
    name: "overview",
    signature: "",
    range: { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 },
    directDeps: sortedDomainIds,
    directUsages: [],
    contentHash: sha256(sortedDomainIds.join("|")),
    facets: synthFacets(sortedDomainIds, [], "."),
    metadata: synthMetadata(PROJECT_BLOCKS),
  };

  return entities;
}
