import { BLOCK_IDS, type BlockId } from "../markdown/block-ids.js";
import type {
  BlockSkipReason,
  CodeEntity,
  CodeloreConfig,
  EntityDocumentationDecision,
  EntityMetrics,
} from "../types.js";

export interface BlockInclusionResult {
  allowedBlocks: BlockId[];
  skipped: BlockSkipReason[];
}

const ALWAYS_INCLUDED: BlockId[] = ["purpose", "responsibility", "invariants", "limitations"];

export function determineBlockInclusion(
  entity: CodeEntity,
  metrics: EntityMetrics,
  decision: EntityDocumentationDecision,
  config: CodeloreConfig
): BlockInclusionResult {
  if (!config.blockInclusion.enabled) {
    return { allowedBlocks: [...BLOCK_IDS], skipped: [] };
  }

  const included = new Set<BlockId>(ALWAYS_INCLUDED);
  const skipped: BlockSkipReason[] = [];

  const dependenciesDecision = shouldIncludeDependencies(entity, metrics);
  if (dependenciesDecision.include) {
    included.add("dependencies");
  } else {
    skipped.push({ blockId: "dependencies", reason: dependenciesDecision.reason });
  }

  const workflowsDecision = shouldIncludeWorkflows(metrics);
  if (workflowsDecision.include) {
    included.add("workflows");
  } else {
    skipped.push({ blockId: "workflows", reason: workflowsDecision.reason });
  }

  const changeGuideDecision = shouldIncludeChangeGuide(decision);
  if (changeGuideDecision.include) {
    included.add("changeGuide");
  } else {
    skipped.push({ blockId: "changeGuide", reason: changeGuideDecision.reason });
  }

  return {
    allowedBlocks: BLOCK_IDS.filter((blockId) => included.has(blockId)),
    skipped,
  };
}

type Verdict = { include: true } | { include: false; reason: string };

function shouldIncludeDependencies(entity: CodeEntity, metrics: EntityMetrics): Verdict {
  if (externalInternalDeps(entity).length > 0) {
    return { include: true };
  }

  if (metrics.globals.used.length > 0) {
    return { include: true };
  }

  for (const specifier of metrics.imports.specifiers) {
    if (!specifier.isReferenced || specifier.isTypeOnly) {
      continue;
    }

    if (!specifier.isExternal) {
      return { include: true };
    }

    if (!specifier.isStdlib) {
      return { include: true };
    }
  }

  return {
    include: false,
    reason: "no internal deps; no significant globals; all referenced imports are stdlib or type-only",
  };
}

function externalInternalDeps(entity: CodeEntity): string[] {
  const ownMethodPrefix = `${entity.id}.`;
  return entity.directDeps.filter((dep) => !dep.startsWith(ownMethodPrefix));
}

function shouldIncludeWorkflows(metrics: EntityMetrics): Verdict {
  if (metrics.inDegree > 0 || metrics.isEntryPoint) {
    return { include: true };
  }

  return {
    include: false,
    reason: "inDegree=0 and not an entry point",
  };
}

function shouldIncludeChangeGuide(decision: EntityDocumentationDecision): Verdict {
  if (decision.role === "full_page") {
    return { include: true };
  }

  return {
    include: false,
    reason: `role is "${decision.role}", changeGuide reserved for full_page`,
  };
}
