import { DOMAIN_ID_PREFIX } from "../indexer/domain-entities.js";
import type { CodeEntity, DocIndex, DocSection, ProjectIndex } from "../types.js";
import { sha256 } from "../utils/hash.js";

/** The source-file path an entity id points at, or undefined for a tier id. */
function sourcePathOf(entityId: string): string | undefined {
  if (entityId.startsWith("file:")) {
    return entityId.slice("file:".length);
  }
  if (entityId.startsWith("symbol:")) {
    const hash = entityId.indexOf("#");
    return entityId.slice("symbol:".length, hash > 0 ? hash : undefined);
  }
  return undefined;
}

function purposeAndResponsibility(section: DocSection): string {
  const purpose = section.blocks.find((block) => block.id === "purpose")?.body ?? "";
  const responsibility = section.blocks.find((block) => block.id === "responsibility")?.body ?? "";
  return [purpose, responsibility].filter(Boolean).join(" ");
}

/** Source-file path → its sections, from the doc index (grouped by the section's owned source ids). */
function sectionsByFile(docs: DocIndex): Map<string, DocSection[]> {
  const byFile = new Map<string, DocSection[]>();
  for (const section of Object.values(docs.sections)) {
    const ownerPath = section.owns.map(sourcePathOf).find((path): path is string => path !== undefined);
    if (!ownerPath) {
      continue;
    }
    const list = byFile.get(ownerPath) ?? [];
    list.push(section);
    byFile.set(ownerPath, list);
  }
  return byFile;
}

/**
 * The canonical member-doc text a tier (domain/project) doc summarizes, from the
 * doc index. A domain's members are its source files; the project's members are
 * its domains. Deterministic and order-stable, so the same inputs always hash the
 * same — the fingerprint stamped at generation and the one recomputed at
 * drift-check time agree exactly. Content, not ids: a reworded member doc changes
 * this text, which is what makes the tier doc go stale.
 */
export function collectDomainMemberEvidence(entity: CodeEntity, index: ProjectIndex): string {
  const parts: string[] = [];
  if (entity.type === "project") {
    for (const depId of entity.directDeps) {
      if (!depId.startsWith(DOMAIN_ID_PREFIX)) {
        continue;
      }
      for (const sectionId of index.docs.entityToSections[depId] ?? []) {
        const section = index.docs.sections[sectionId];
        if (section) {
          parts.push(`${depId} — ${purposeAndResponsibility(section)}`);
        }
      }
    }
    return parts.sort().join("\n");
  }

  const byFile = sectionsByFile(index.docs);
  for (const depId of entity.directDeps) {
    const path = sourcePathOf(depId);
    if (!path) {
      continue;
    }
    for (const section of byFile.get(path) ?? []) {
      parts.push(`${path} — ${section.heading}: ${purposeAndResponsibility(section)}`);
    }
  }
  return parts.sort().join("\n");
}

export function domainMemberFingerprint(evidence: string): string {
  return sha256(evidence);
}
