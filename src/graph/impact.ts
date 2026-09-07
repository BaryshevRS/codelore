import type { AffectedSection, CodeIndex, DocIndex } from "../types.js";

function collectDirectlyAffected(
  docs: DocIndex,
  entityIds: string[],
  affected: Map<string, AffectedSection>,
  queue: string[]
): void {
  for (const entityId of entityIds) {
    for (const section of Object.values(docs.sections)) {
      if (section.owns.includes(entityId)) {
        addAffected(affected, queue, section.id, `owns changed entity ${entityId}`, 0);
      } else if (section.depends.includes(entityId)) {
        addAffected(affected, queue, section.id, `depends on changed entity ${entityId}`, 1);
      }
    }
  }
}

function propagateTransitive(docs: DocIndex, affected: Map<string, AffectedSection>, queue: string[]): void {
  while (queue.length > 0) {
    const sectionId = queue.shift();
    if (!sectionId) {
      continue;
    }
    for (const section of Object.values(docs.sections)) {
      if (section.depends.includes(sectionId) || section.depends.includes(`section:${sectionId}`)) {
        addAffected(affected, queue, section.id, `depends on affected section ${sectionId}`, 2);
      }
    }
  }
}

export function getAffectedSectionsForEntities(docs: DocIndex, entityIds: string[]): AffectedSection[] {
  const affected = new Map<string, AffectedSection>();
  const queue: string[] = [];

  collectDirectlyAffected(docs, entityIds, affected, queue);
  propagateTransitive(docs, affected, queue);

  return [...affected.values()].sort(
    (left, right) => left.order - right.order || left.sectionId.localeCompare(right.sectionId)
  );
}

export function getImpactForEntity(code: CodeIndex, docs: DocIndex, entityId: string): unknown {
  const entity = code.entities[entityId];
  const ownedSections = Object.values(docs.sections)
    .filter((section) => section.owns.includes(entityId))
    .map((section) => section.id)
    .sort();
  const dependentSections = Object.values(docs.sections)
    .filter((section) => section.depends.includes(entityId))
    .map((section) => section.id)
    .sort();

  return {
    entityId,
    directDeps: entity?.directDeps ?? [],
    directUsages: entity?.directUsages ?? [],
    ownedSections,
    dependentSections,
  };
}

function addAffected(
  affected: Map<string, AffectedSection>,
  queue: string[],
  sectionId: string,
  reason: string,
  order: number
): void {
  const existing = affected.get(sectionId);
  if (existing) {
    if (!existing.reason.includes(reason)) {
      existing.reason = `${existing.reason}; ${reason}`;
    }
    existing.order = Math.min(existing.order, order);
    return;
  }

  affected.set(sectionId, { sectionId, reason, order });
  queue.push(sectionId);
}
