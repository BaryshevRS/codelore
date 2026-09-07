import type {
  CodeEntity,
  CodeloreConfig,
  DocumentationRole,
  EntityDocumentationDecision,
  EntityMetrics,
} from "../types.js";
import type { ClassCohesion } from "./class-cohesion.js";
import { effectiveDirectUsages } from "./entity-metrics.js";
import type { WrapperDetection } from "./wrapper-detector.js";

export function decideDocumentationRoles(
  entities: Record<string, CodeEntity>,
  metrics: Map<string, EntityMetrics>,
  cohesion: Map<string, ClassCohesion>,
  wrappers: WrapperDetection,
  config: CodeloreConfig
): Map<string, EntityDocumentationDecision> {
  const decisions = new Map<string, EntityDocumentationDecision>();
  const cohesiveMethodOwners = cohesiveMethodOwnerMap(cohesion);
  const sorted = sortedEntities(entities);

  for (const entity of sorted) {
    if (entity.type === "file") {
      continue;
    }
    decisions.set(entity.id, decideEntityRole(entity, entities, metrics, wrappers, cohesiveMethodOwners, config));
  }

  // File entities are decided after their symbols: a file whose symbols yield
  // two or more documented pages gets a module section of its own — the home
  // for the module story and cross-entity contracts. Below that, the file
  // entity only validates existing file-level docs.
  for (const entity of sorted) {
    if (entity.type !== "file") {
      continue;
    }
    decisions.set(entity.id, decideFileRole(entity, sorted, metrics, decisions));
  }

  return decisions;
}

function decideFileRole(
  entity: CodeEntity,
  sorted: CodeEntity[],
  metrics: Map<string, EntityMetrics>,
  decisions: Map<string, EntityDocumentationDecision>
): EntityDocumentationDecision {
  const weight = calculateWeight(metrics.get(entity.id) ?? fallbackMetrics(entity));
  const pageEntities = sorted.filter((other) => {
    if (other.path !== entity.path || other.type === "file") {
      return false;
    }
    const role = decisions.get(other.id)?.role;
    return role === "short_page" || role === "full_page";
  });
  if (pageEntities.length >= 2) {
    return { weight, role: "short_page", reason: "module section for a file with multiple documented entities" };
  }
  return { weight, role: "one_line", reason: "file entity validates existing file-level docs" };
}

function decideEntityRole(
  entity: CodeEntity,
  entities: Record<string, CodeEntity>,
  metrics: Map<string, EntityMetrics>,
  wrappers: WrapperDetection,
  cohesiveMethodOwners: Map<string, string>,
  config: CodeloreConfig
): EntityDocumentationDecision {
  const entityMetrics = metrics.get(entity.id) ?? fallbackMetrics(entity);
  const wrapperAnchor = wrappers.anchorByPublicId.get(entity.id);
  const absorbedByPrivateCaller = privateAbsorber(entity, entities, wrappers);
  const absorbedByClass = cohesiveMethodOwners.get(entity.id);
  const weight = calculateWeight(entityMetrics, wrapperAnchor ? metrics.get(wrapperAnchor) : undefined);

  if (absorbedByPrivateCaller) {
    return {
      weight,
      role: "absorbed_by_caller",
      absorbedBy: absorbedByPrivateCaller,
      reason: "private method has a single caller",
    };
  }

  if (entityMetrics.isEntryPoint) {
    return { weight, role: "full_page", reason: "entry point override" };
  }

  if (wrapperAnchor) {
    return {
      weight,
      role: "full_page",
      anchorPrivate: wrapperAnchor,
      reason: "public anchor over a private implementation",
    };
  }

  if (absorbedByClass) {
    return {
      weight,
      role: "absorbed",
      absorbedBy: absorbedByClass,
      reason: "method belongs to a cohesive class documented as one page",
    };
  }

  return { weight, role: roleForWeight(weight, config) };
}

function privateAbsorber(
  entity: CodeEntity,
  entities: Record<string, CodeEntity>,
  wrappers: WrapperDetection
): string | undefined {
  const knownWrapper = wrappers.absorbedPrivateById.get(entity.id);
  if (knownWrapper) {
    return knownWrapper;
  }

  const entityUsages = effectiveDirectUsages(entity, entities);
  return wrappers.privateMethodIds.has(entity.id) && entityUsages.length === 1 ? entityUsages[0] : undefined;
}

export function calculateWeight(metrics: EntityMetrics, anchorPrivateMetrics?: EntityMetrics): number {
  const combined: EntityMetrics = anchorPrivateMetrics
    ? {
        statementCount: metrics.statementCount + anchorPrivateMetrics.statementCount,
        inDegree: metrics.inDegree,
        hasSideEffects: metrics.hasSideEffects || anchorPrivateMetrics.hasSideEffects,
        isEntryPoint: metrics.isEntryPoint,
        imports: metrics.imports,
        globals: metrics.globals,
      }
    : metrics;

  return (
    (1 + (combined.hasSideEffects ? 5 : 0)) *
    Math.log(combined.statementCount + 2) *
    (1 + 0.5 * Math.log(combined.inDegree + 1))
  );
}

function roleForWeight(weight: number, config: CodeloreConfig): DocumentationRole {
  if (weight < config.thresholds.weightMinimal) {
    return "one_line";
  }

  if (weight < config.thresholds.weightFull) {
    return "short_page";
  }

  return "full_page";
}

function cohesiveMethodOwnerMap(cohesion: Map<string, ClassCohesion>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const item of cohesion.values()) {
    if (!item.cohesive) {
      continue;
    }

    for (const methodId of item.absorbedMethodIds) {
      owners.set(methodId, item.classEntityId);
    }
  }
  return owners;
}

function fallbackMetrics(entity: CodeEntity): EntityMetrics {
  return {
    statementCount: 0,
    inDegree: entity.directUsages.length,
    hasSideEffects: false,
    isEntryPoint: false,
    imports: { specifiers: [] },
    globals: { used: [] },
  };
}

function sortedEntities(entities: Record<string, CodeEntity>): CodeEntity[] {
  return Object.values(entities).sort(
    (left, right) => left.path.localeCompare(right.path) || left.range.startOffset - right.range.startOffset
  );
}
