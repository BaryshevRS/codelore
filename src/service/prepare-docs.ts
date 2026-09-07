import type { CodeIndexScope } from "../indexer/code-indexer.js";
import { computeBlockFingerprint } from "../markdown/block-facets.js";
import { BLOCK_IDS, type BlockId } from "../markdown/block-ids.js";
import { DOC_STATE_VERSION } from "../storage/doc-state-storage.js";
import type {
  BlockSkipReason,
  CodeEntity,
  DocSection,
  DocState,
  DocStateBlock,
  DocStateSection,
  PreparedDocSection,
  PrepareInitialDocsInput,
  PrepareInitialDocsNextAction,
  PrepareInitialDocsResult,
  ProjectIndex,
} from "../types.js";
import { toPosixPath } from "../utils/path.js";
import type { planFileLayout } from "./file-layout.js";
import { uniqueSorted } from "./helpers.js";

export function emptyDocState(docPath: string): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath,
    generatedAt: new Date().toISOString(),
    sectionOrder: [],
    sections: {},
  };
}

export function allowedBlockIds(entity: CodeEntity): BlockId[] {
  const meta = entity.metadata?.allowedBlocks;
  return meta && meta.length > 0 ? [...meta] : [...BLOCK_IDS];
}

export function orderBlocks(allowed: BlockId[]): BlockId[] {
  const set = new Set(allowed);
  return BLOCK_IDS.filter((id) => set.has(id));
}

export function anchorForHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s-]/gi, "")
    .replace(/\s+/g, "-");
}

export type NormalizedPrepareScope = Required<Pick<PrepareInitialDocsInput, "dryRun">> & {
  paths: string[];
  files: string[];
  entityIds: string[];
};

export type SkippedPreparedDocSection = PrepareInitialDocsResult["skippedSections"][number];
export type PlannedFileSection = ReturnType<typeof planFileLayout>[number];

export function preparedDocsResult(
  index: ProjectIndex,
  scope: NormalizedPrepareScope,
  scopedEntities: CodeEntity[],
  skippedSections: SkippedPreparedDocSection[],
  plannedSections: PreparedDocSection[],
  createdSections: PreparedDocSection[],
  dryRun: boolean
): PrepareInitialDocsResult {
  const nextStep = prepareInitialDocsNextStep(scope, scopedEntities, plannedSections, createdSections, skippedSections);
  return {
    dryRun,
    scope: publicPrepareScope(scope),
    nextAction: nextStep.nextAction,
    guidance: nextStep.guidance,
    summary: prepareInitialDocsSummary(index, scope, scopedEntities, skippedSections, plannedSections, createdSections),
    plannedSections,
    createdSections,
    skippedSections,
    skippedBlocksByEntity: collectSkippedBlocksByEntity([...plannedSections, ...createdSections], index.code.entities),
  };
}

/**
 * Recreating a section must never erase written documentation: any non-empty
 * block from the previous state survives into the fresh skeleton.
 */
export function withPreservedBlockBodies(previous: DocStateSection, fresh: DocStateSection): DocStateSection {
  for (const [blockId, prevBlock] of Object.entries(previous.blocks) as Array<[BlockId, DocStateBlock]>) {
    if (prevBlock.body.trim() === "") {
      continue;
    }
    const freshBlock = fresh.blocks[blockId];
    if (freshBlock && freshBlock.body.trim() !== "") {
      continue;
    }
    fresh.blocks[blockId] = prevBlock;
    if (!fresh.blockOrder.includes(blockId)) {
      fresh.blockOrder.push(blockId);
    }
    if (!fresh.allowedBlocks.includes(blockId)) {
      fresh.allowedBlocks.push(blockId);
    }
  }
  return fresh;
}

export function docStateSectionForPlannedEntity(
  planned: PlannedFileSection,
  entity: CodeEntity,
  entities: Record<string, CodeEntity>
): DocStateSection {
  const allowed = allowedBlockIds(entity);
  const order = orderBlocks(allowed);
  const blocks: Record<string, DocStateBlock> = {};
  for (const blockId of order) {
    const fingerprint = computeBlockFingerprint(blockId, [entity.id], entities);
    blocks[blockId] = {
      body: "",
      rendered: false,
      ...(fingerprint !== undefined ? { fingerprint } : {}),
    };
  }
  return {
    heading: planned.heading,
    depth: planned.depth,
    anchor: anchorForHeading(planned.heading),
    ...(entity.type !== "file" && entity.signature ? { signature: entity.signature } : {}),
    owns: [entity.id],
    depends: uniqueSorted([...entity.directDeps]),
    usedBy: uniqueSorted([...entity.directUsages]),
    status: "normal",
    allowedBlocks: allowed,
    blockOrder: order,
    blocks,
  };
}

export function normalizePrepareScope(input: PrepareInitialDocsInput): NormalizedPrepareScope {
  return {
    paths: uniqueSorted((input.paths ?? []).map(normalizePreparePath).filter(Boolean)),
    files: uniqueSorted((input.files ?? []).map(normalizePreparePath).filter(Boolean)),
    entityIds: uniqueSorted(input.entityIds ?? []),
    dryRun: input.dryRun ?? false,
  };
}

export function normalizePreparePath(path: string): string {
  return toPosixPath(path).replace(/^\.\//, "").replace(/\/+$/, "");
}

export function publicPrepareScope(scope: NormalizedPrepareScope): PrepareInitialDocsResult["scope"] {
  return {
    paths: scope.paths,
    files: scope.files,
    entityIds: scope.entityIds,
  };
}

export function prepareInitialDocsSummary(
  index: ProjectIndex,
  scope: NormalizedPrepareScope,
  scopedEntities: CodeEntity[],
  skippedSections: SkippedPreparedDocSection[],
  plannedSections: PreparedDocSection[],
  createdSections: PreparedDocSection[]
): PrepareInitialDocsResult["summary"] {
  const indexedCodeEntities = Object.keys(index.code.entities).length;
  return {
    scopeMode: hasPrepareScope(scope) ? "scoped" : "all",
    totalCodeEntities: indexedCodeEntities,
    indexedCodeEntities,
    indexedCodeFiles: Object.keys(index.code.fileToEntities).length,
    scopedEntities: scopedEntities.length,
    alreadyDocumentedEntities: skippedSections.length,
    missingEntities: plannedSections.length,
    plannedSections: plannedSections.length,
    createdSections: createdSections.length,
  };
}

export function prepareInitialDocsNextStep(
  scope: NormalizedPrepareScope,
  scopedEntities: CodeEntity[],
  plannedSections: PreparedDocSection[],
  createdSections: PreparedDocSection[],
  skippedSections: SkippedPreparedDocSection[]
): { nextAction: PrepareInitialDocsNextAction; guidance: string } {
  if (scopedEntities.length === 0) {
    return {
      nextAction: "stop_no_matching_entities",
      guidance:
        "No supported .ts/.js code entities matched this scope. Stop and report the requested scope; do not broaden it automatically.",
    };
  }
  if (scope.dryRun && plannedSections.length > 0) {
    return {
      nextAction: "run_without_dry_run",
      guidance:
        "Dry run found missing documentation sections. In CLI, run prepare-initial-docs again with the same scope and without --dry-run, or run generate for the same scope to create and fill docs.",
    };
  }
  if (!scope.dryRun && createdSections.length > 0) {
    return {
      nextAction: "fill_created_sections",
      guidance:
        "Fill only createdSections. In MCP, call document with entityIds or the same scope. In CLI, run generate for the same scope. The server runs the full LLM pipeline; do not compose lower-level steps and do not rewrite skippedSections.",
    };
  }
  if (skippedSections.length > 0) {
    return {
      nextAction: "stop_already_documented",
      guidance:
        "All matched entities are already documented. Stop here; skippedSections are not rewrite targets unless the user explicitly asked to revise existing documentation.",
    };
  }
  return {
    nextAction: "stop_no_matching_entities",
    guidance:
      "No missing documentation sections were found. Stop and report the result; do not broaden the scope automatically.",
  };
}

export function codeIndexScopeFromPrepareScope(scope: NormalizedPrepareScope): CodeIndexScope | undefined {
  if (!hasPrepareScope(scope)) {
    return undefined;
  }
  return {
    paths: scope.paths,
    files: scope.files,
    entityIds: scope.entityIds,
  };
}

export function hasPrepareScope(scope: NormalizedPrepareScope): boolean {
  return scope.paths.length > 0 || scope.files.length > 0 || scope.entityIds.length > 0;
}

export function skippedPreparedDocSection(index: ProjectIndex, entity: CodeEntity): SkippedPreparedDocSection {
  const sectionIds = index.docs.entityToSections[entity.id] ?? [];
  return {
    entityId: entity.id,
    reason: "already_documented",
    sectionIds,
    docPaths: uniqueSorted(sectionIds.map((sectionId) => index.docs.sections[sectionId]?.docPath).filter(Boolean)),
  };
}

export function isSectionSkeleton(section: DocSection): boolean {
  return section.blocks.every((block) => block.body.trim() === "");
}

export function isEntityInPrepareScope(entity: CodeEntity, scope: NormalizedPrepareScope): boolean {
  const hasScope = scope.paths.length > 0 || scope.files.length > 0 || scope.entityIds.length > 0;
  if (!hasScope) {
    return true;
  }
  return (
    scope.entityIds.includes(entity.id) ||
    scope.files.includes(entity.path) ||
    scope.paths.some((path) => entity.path === path || entity.path.startsWith(`${path}/`))
  );
}

export function shouldCreatePage(entity: CodeEntity): boolean {
  return (
    entity.metadata?.role === "short_page" || entity.metadata?.role === "full_page" || entity.metadata === undefined
  );
}

export function collectSkippedBlocksByEntity(
  sections: PreparedDocSection[],
  entities: Record<string, CodeEntity>
): Array<{ entityId: string; skipped: BlockSkipReason[] }> {
  const seen = new Set<string>();
  const result: Array<{ entityId: string; skipped: BlockSkipReason[] }> = [];

  for (const { entityId } of sections) {
    if (seen.has(entityId)) {
      continue;
    }
    seen.add(entityId);
    const skipped = entities[entityId]?.metadata?.skippedBlocks ?? [];
    if (skipped.length > 0) {
      result.push({ entityId, skipped });
    }
  }

  return result.sort((left, right) => left.entityId.localeCompare(right.entityId));
}
