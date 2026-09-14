import { BLOCK_FACETS, computeBlockFingerprint } from "../markdown/block-facets.js";
import type { BlockId } from "../markdown/block-ids.js";
import type { CodeEntity, DocSection, DocValidationIssue } from "../types.js";
import { isKnownBlockId } from "./helpers.js";
import { staleBlockInfoFor } from "./stale-detection.js";

export function validateOwnedEntities(
  section: DocSection,
  codeEntities: Record<string, CodeEntity>
): DocValidationIssue[] {
  const issues: DocValidationIssue[] = [];
  for (const ownedEntityId of section.owns) {
    if (!codeEntities[ownedEntityId]) {
      issues.push({
        code: "stale_owned_entity",
        severity: "error",
        sectionId: section.id,
        docPath: section.docPath,
        entityId: ownedEntityId,
        message: `Section owns missing code entity "${ownedEntityId}".`,
      });
    }
  }
  return issues;
}

export function detectStaleBlocks(section: DocSection, codeEntities: Record<string, CodeEntity>): DocValidationIssue[] {
  const issues: DocValidationIssue[] = [];
  if (section.owns.length === 0) {
    return issues;
  }
  const presentOwns = section.owns.filter((id) => codeEntities[id]);
  if (presentOwns.length === 0) {
    return issues;
  }

  for (const block of section.blocks) {
    if (!isKnownBlockId(block.id)) {
      continue;
    }
    const issue = staleValidationIssue(section, block, block.id, presentOwns, codeEntities);
    if (issue) {
      issues.push(issue);
    }
  }
  return issues;
}

export function staleValidationIssue(
  section: DocSection,
  block: DocSection["blocks"][number],
  blockId: BlockId,
  presentOwns: string[],
  codeEntities: Record<string, CodeEntity>
): DocValidationIssue | undefined {
  const currentValue = computeBlockFingerprint(blockId, presentOwns, codeEntities);
  if (currentValue === undefined) {
    return undefined;
  }
  if (block.staleSince !== undefined) {
    return {
      code: "stale_block",
      severity: "warning",
      sectionId: section.id,
      docPath: section.docPath,
      blockId,
      drift: "tombstoned",
      changedFacets: block.staleFacets ?? [...BLOCK_FACETS[blockId]],
      message: `Block "${block.heading}" is tombstoned (${block.staleReason ?? "code_changed"}) since ${block.staleSince}; rewrite to restore.`,
    };
  }
  // One detector, not two: `check` used to re-implement this comparison, which meant
  // a rule added on one side (a facet whose derivation changed, say) silently did not
  // apply on the other.
  const drift = staleBlockInfoFor(section, block, presentOwns, codeEntities);
  if (!drift) {
    return undefined;
  }
  return {
    code: "stale_block",
    severity: "warning",
    sectionId: section.id,
    docPath: section.docPath,
    blockId,
    drift: "facet_changed",
    changedFacets: drift.changedFacets,
    message: `Block "${block.heading}" is stale: ${drift.changedFacets.join(", ")} changed since last rewrite.`,
  };
}

export function validateDependencies(
  section: DocSection,
  codeEntities: Record<string, CodeEntity>,
  docSections: Record<string, DocSection>
): DocValidationIssue[] {
  const issues: DocValidationIssue[] = [];
  for (const dependencyId of section.depends) {
    const normalizedSectionId = dependencyId.startsWith("section:")
      ? dependencyId.slice("section:".length)
      : dependencyId;
    if (!codeEntities[dependencyId] && !docSections[dependencyId] && !docSections[normalizedSectionId]) {
      issues.push({
        code: "broken_dependency",
        severity: "error",
        sectionId: section.id,
        docPath: section.docPath,
        entityId: dependencyId,
        message: `Section depends on missing entity or section "${dependencyId}".`,
      });
    }
  }
  return issues;
}

export function validateBlockQuality(section: DocSection): DocValidationIssue[] {
  const issues: DocValidationIssue[] = [];
  for (const block of section.blocks) {
    if (!block.rendered) {
      issues.push({
        code: "empty_required_block",
        severity: "warning",
        sectionId: section.id,
        docPath: section.docPath,
        message: `Block "${block.heading}" is empty or filtered out.`,
      });
      continue;
    }
    const body = block.body.trim();
    if (body.length === 0 || body === "TODO") {
      issues.push({
        code: "empty_required_block",
        severity: "warning",
        sectionId: section.id,
        docPath: section.docPath,
        message: `Block "${block.heading}" is empty or still TODO.`,
      });
    }
  }
  return issues;
}
