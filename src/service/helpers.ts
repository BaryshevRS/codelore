import { CodeloreError } from "../errors.js";
import { BLOCK_IDS, type BlockId } from "../markdown/block-ids.js";
import type { CodeEntity, CodeEntitySummary, DocSection, SectionContext } from "../types.js";

export function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function uniqueEntities(entities: CodeEntity[]): CodeEntity[] {
  const seen = new Set<string>();
  const unique: CodeEntity[] = [];
  for (const entity of entities) {
    if (!seen.has(entity.id)) {
      seen.add(entity.id);
      unique.push(entity);
    }
  }
  return unique.sort((left, right) => left.id.localeCompare(right.id));
}

export function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

export function summarizeCodeEntity(entity: CodeEntity): CodeEntitySummary {
  return {
    id: entity.id,
    type: entity.type,
    path: entity.path,
    name: entity.name,
    signature: entity.signature,
    range: entity.range,
    contentHash: entity.contentHash,
    metadata: entity.metadata,
    directDepCount: entity.directDeps.length,
    directUsageCount: entity.directUsages.length,
  };
}

export function summarizeDocSection(section: DocSection): SectionContext["section"] {
  return {
    id: section.id,
    docPath: section.docPath,
    heading: section.heading,
    depth: section.depth,
    anchor: section.anchor,
    owns: section.owns,
    depends: section.depends,
    usedBy: section.usedBy,
    status: section.status,
    allowedBlocks: section.allowedBlocks,
    blocks: section.blocks.map((block) => ({
      id: block.id,
      heading: block.heading,
      depth: block.depth,
      body: block.body,
      rendered: block.rendered,
      staleSince: block.staleSince,
      staleReason: block.staleReason,
      staleFacets: block.staleFacets,
    })),
  };
}

export function groupBy<T>(items: T[], keyForItem: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

export function isKnownBlockId(value: string): value is BlockId {
  return (BLOCK_IDS as readonly string[]).includes(value);
}

export function describeError(error: unknown): { error: string; code?: string } {
  if (error instanceof CodeloreError) {
    return { error: error.message, code: error.code };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
