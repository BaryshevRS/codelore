import type { AstFacet, CodeEntity, Facet } from "../types.js";
import { sha256 } from "../utils/hash.js";
import type { BlockId } from "./block-ids.js";

export const BLOCK_FACETS: Record<BlockId, readonly AstFacet[]> = {
  purpose: ["signature", "placement"],
  responsibility: ["signature", "deps", "usage"],
  invariants: ["signature", "body"],
  dependencies: ["deps"],
  workflows: ["body", "deps"],
  limitations: ["body"],
  changeGuide: ["body", "deps", "usage", "placement"],
};

const ALL_FACETS: readonly AstFacet[] = ["signature", "body", "deps", "usage", "placement"];

export function computeBlockFingerprint(
  blockId: BlockId,
  ownedEntityIds: string[],
  entities: Record<string, CodeEntity>
): string | undefined {
  if (ownedEntityIds.length === 0) {
    return undefined;
  }
  const sortedIds = [...ownedEntityIds].sort();
  const presentIds = sortedIds.filter((id) => entities[id]);
  if (presentIds.length === 0) {
    return undefined;
  }
  return BLOCK_FACETS[blockId]
    .map((facet) => `${facet}=${hashFacetAcrossEntities(facet, presentIds, entities)}`)
    .join(",");
}

/**
 * Hash of the canonical body a translation was produced from. A translation whose
 * stored `sourceFingerprint` no longer equals this is stale: the canonical prose
 * changed and the translation must be regenerated. Trimmed so cosmetic trailing
 * whitespace does not invalidate a translation.
 */
export function translationSourceFingerprint(body: string): string {
  return sha256(body.trim());
}

export function parseBlockFingerprintValue(value: string): Partial<Record<AstFacet, string>> {
  const result: Partial<Record<AstFacet, string>> = {};
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const facet = part.slice(0, eq).trim();
    const hash = part.slice(eq + 1).trim();
    if (isFacet(facet) && hash.length > 0) {
      result[facet] = hash;
    }
  }
  return result;
}

export function diffFacetHashes(
  stored: Partial<Record<AstFacet, string>>,
  current: Partial<Record<AstFacet, string>>
): Facet[] {
  const changed: Facet[] = [];
  for (const facet of ALL_FACETS) {
    const left = stored[facet];
    const right = current[facet];
    if (left !== undefined && right !== undefined && left !== right) {
      changed.push(facet);
    }
  }
  return changed;
}

function hashFacetAcrossEntities(facet: AstFacet, ids: string[], entities: Record<string, CodeEntity>): string {
  return sha256(ids.map((id) => `${id}|${entities[id].facets[facet]}`).join("\n"));
}

function isFacet(value: string): value is AstFacet {
  return ALL_FACETS.includes(value as AstFacet);
}
