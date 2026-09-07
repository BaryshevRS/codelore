import type { BlockId } from "../markdown/block-ids.js";
import { MENTIONED_PATH_PATTERN, MENTIONED_SYMBOL_PATTERN, SYMBOL_CANDIDATE } from "../markdown/linkify.js";
import type { FileWriteResult, FileWriteSection } from "./file-writer.js";

const MAX_BLOCK_CHARS = 2500;

export interface DocViolation {
  sectionId: string;
  blockId: BlockId;
  rule:
    | "unknown_ref"
    | "ref_outside_context"
    | "ref_role_mismatch"
    | "text_too_long"
    | "path_not_found"
    | "unsupported_claim";
  detail: string;
}

export interface ValidateFileWriteInput {
  result: FileWriteResult;
  sections: FileWriteSection[];
  groupFiles: string[];
  knownEntityIds: ReadonlySet<string>;
  knownFiles: ReadonlySet<string>;
  dependencyDocPaths: ReadonlySet<string>;
  /** Maps a bare entity name to its symbol ids, for grounding symbols named in prose. */
  entityNameToIds: ReadonlyMap<string, readonly string[]>;
  /** Existence check for project-relative paths mentioned in prose (tests, snapshots are not in the code index). */
  fileExists?: (relativePath: string) => boolean;
}

/** Groups entity ids by their bare name (e.g. `buildFileDag`, `CodeloreService.run`). */
export function buildEntityNameToIds(entities: Record<string, { name: string }>): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const add = (name: string, id: string): void => {
    const ids = byName.get(name);
    if (!ids) {
      byName.set(name, [id]);
    } else if (!ids.includes(id)) {
      ids.push(id);
    }
  };
  for (const [id, entity] of Object.entries(entities)) {
    add(entity.name, id);
    // Methods are named "Class.method"; also index the bare method name so a prose
    // mention of `method` resolves and gets checked against the section's context.
    // Without this, bare method names silently escape validateMentionedSymbols.
    const dot = entity.name.lastIndexOf(".");
    if (dot >= 0 && dot < entity.name.length - 1) {
      add(entity.name.slice(dot + 1), id);
    }
  }
  return byName;
}

export function validateFileWrite(input: ValidateFileWriteInput): DocViolation[] {
  const violations: DocViolation[] = [];
  const sectionById = new Map(input.sections.map((section) => [section.sectionId, section]));

  for (const [sectionId, blocks] of Object.entries(input.result)) {
    const section = sectionById.get(sectionId);
    if (!section) {
      continue;
    }
    const allowedRefs = allowedRefsForSection(section, input);
    const callerIds = new Set(section.callers.map((caller) => caller.id));
    const depIds = new Set(section.dependencyEntityIds);
    for (const [blockId, block] of Object.entries(blocks) as Array<
      [BlockId, NonNullable<FileWriteResult[string][BlockId]>]
    >) {
      if (block.text.length > MAX_BLOCK_CHARS) {
        violations.push({
          sectionId,
          blockId,
          rule: "text_too_long",
          detail: `Block text is ${block.text.length} chars; the limit is ${MAX_BLOCK_CHARS}. Rewrite more concisely.`,
        });
      }
      for (const ref of block.refs) {
        violations.push(...validateRef(ref, sectionId, blockId, allowedRefs, input));
        violations.push(...validateRefRole(ref, sectionId, blockId, section.entity.id, callerIds, depIds));
      }
      violations.push(...validateMentionedPaths(block.text, sectionId, blockId, input));
      violations.push(...validateMentionedSymbols(block.text, sectionId, blockId, allowedRefs, input.entityNameToIds));
    }
  }
  return violations;
}

/** Models invent conventional paths (__tests__/, __snapshots__/); every mentioned path must exist. */
function validateMentionedPaths(
  text: string,
  sectionId: string,
  blockId: BlockId,
  input: ValidateFileWriteInput
): DocViolation[] {
  if (!input.fileExists) {
    return [];
  }
  const violations: DocViolation[] = [];
  for (const match of new Set(text.match(MENTIONED_PATH_PATTERN) ?? [])) {
    const candidate = match.replace(/[.,;]+$/, "");
    if (input.knownFiles.has(candidate) || input.fileExists(candidate)) {
      continue;
    }
    // NodeNext import specifiers name compiled files: "./provider.js" on disk is provider.ts.
    const tsCandidate = candidate.replace(/\.js$/, ".ts");
    if (tsCandidate !== candidate && (input.knownFiles.has(tsCandidate) || input.fileExists(tsCandidate))) {
      continue;
    }
    violations.push({
      sectionId,
      blockId,
      rule: "path_not_found",
      detail: `Path "${candidate}" mentioned in the text does not exist in the project. Correct it or drop the statement.`,
    });
  }
  return violations;
}

/** Shared guidance for a reference that exists in the index but outside the section's context. */
function outsideContextDetail(subject: string): string {
  return `${subject} is not part of this section's context (own entity, callers, dependencies, dependency docs). Remove the statement or ground it in the provided context.`;
}

/**
 * Symbols named only in prose escape validateRef, which sees the writer's tagged
 * refs array alone. Mirror validateMentionedPaths: scan backtick-quoted
 * identifiers and flag any that resolve to a known symbol outside this section's
 * context. Private same-file helpers are not indexed, so they never resolve here.
 */
function validateMentionedSymbols(
  text: string,
  sectionId: string,
  blockId: BlockId,
  allowedRefs: ReadonlySet<string>,
  entityNameToIds: ReadonlyMap<string, readonly string[]>
): DocViolation[] {
  const candidates = new Set<string>();
  for (const match of text.matchAll(MENTIONED_SYMBOL_PATTERN)) {
    const candidate = match[1].trim().replace(/\(\)$/, "");
    if (SYMBOL_CANDIDATE.test(candidate)) {
      candidates.add(candidate);
    }
  }
  const violations: DocViolation[] = [];
  for (const candidate of candidates) {
    const ids = entityNameToIds.get(candidate);
    if (!ids || ids.some((id) => allowedRefs.has(id))) {
      continue;
    }
    violations.push({
      sectionId,
      blockId,
      rule: "ref_outside_context",
      detail: outsideContextDetail(`Symbol "${candidate}" mentioned in the text exists but`),
    });
  }
  return violations;
}

/**
 * The dependencies block lists what the entity uses; a caller (who uses the
 * entity) cited there reverses the relationship. Callers and deps arrive as
 * distinct sets, so the misclassification is caught deterministically. Symbol
 * ids only — a path is ambiguous (the same file can host a caller and a dep).
 */
function validateRefRole(
  ref: string,
  sectionId: string,
  blockId: BlockId,
  ownEntityId: string,
  callerIds: ReadonlySet<string>,
  depIds: ReadonlySet<string>
): DocViolation[] {
  if (blockId !== "dependencies") {
    return [];
  }
  const normalized = normalizeRef(ref);
  if (normalized === ownEntityId || depIds.has(normalized) || !callerIds.has(normalized)) {
    return [];
  }
  return [
    {
      sectionId,
      blockId,
      rule: "ref_role_mismatch",
      detail: `Ref "${ref}" is a caller of this entity, not a dependency. The dependencies block lists only what this entity uses — move the statement to workflows or drop it.`,
    },
  ];
}

function validateRef(
  ref: string,
  sectionId: string,
  blockId: BlockId,
  allowedRefs: ReadonlySet<string>,
  input: ValidateFileWriteInput
): DocViolation[] {
  const normalized = normalizeRef(ref);
  if (allowedRefs.has(normalized)) {
    return [];
  }
  const existsInIndex =
    input.knownEntityIds.has(normalized) ||
    input.knownFiles.has(normalized) ||
    (normalized.startsWith("file:") && input.knownFiles.has(normalized.slice("file:".length)));
  if (!existsInIndex && !input.dependencyDocPaths.has(normalized)) {
    return [
      {
        sectionId,
        blockId,
        rule: "unknown_ref",
        detail: `Ref "${ref}" does not exist in the code index. Remove the ref and any statement that relies on it.`,
      },
    ];
  }
  return [
    {
      sectionId,
      blockId,
      rule: "ref_outside_context",
      detail: outsideContextDetail(`Ref "${ref}" exists but`),
    },
  ];
}

/**
 * The subset of a block's refs that fail deterministic ref checks (unknown,
 * outside-context, or role-mismatched). Refs are structured metadata, so dropping
 * exactly these and keeping the prose is safe: any prose that actually depended on
 * a dropped ref is caught independently by the mentioned-symbol/path checks.
 */
export function invalidRefsForBlock(
  section: FileWriteSection,
  blockId: BlockId,
  refs: readonly string[],
  input: Pick<ValidateFileWriteInput, "groupFiles" | "knownEntityIds" | "knownFiles" | "dependencyDocPaths">
): string[] {
  const allowedRefs = allowedRefsForSection(section, input);
  const callerIds = new Set(section.callers.map((caller) => caller.id));
  const depIds = new Set(section.dependencyEntityIds);
  const bad: string[] = [];
  for (const ref of refs) {
    const violations = [
      ...validateRef(ref, section.sectionId, blockId, allowedRefs, input as ValidateFileWriteInput),
      ...validateRefRole(ref, section.sectionId, blockId, section.entity.id, callerIds, depIds),
    ];
    if (violations.length > 0) {
      bad.push(ref);
    }
  }
  return bad;
}

export function allowedRefsForSection(
  section: FileWriteSection,
  input: Pick<ValidateFileWriteInput, "dependencyDocPaths" | "groupFiles">
): Set<string> {
  const allowed = new Set<string>();
  allowed.add(section.entity.id);
  for (const caller of section.callers) {
    allowed.add(caller.id);
    allowed.add(caller.path);
  }
  for (const depId of section.dependencyEntityIds) {
    allowed.add(depId);
    const path = pathOfEntityId(depId);
    if (path) {
      allowed.add(path);
      allowed.add(`file:${path}`);
    }
  }
  for (const docPath of input.dependencyDocPaths) {
    allowed.add(docPath);
    allowed.add(`file:${docPath}`);
  }
  for (const file of input.groupFiles) {
    allowed.add(file);
    allowed.add(`file:${file}`);
  }
  const ownPath = pathOfEntityId(section.entity.id);
  if (ownPath) {
    allowed.add(ownPath);
    allowed.add(`file:${ownPath}`);
  }
  return allowed;
}

function normalizeRef(ref: string): string {
  return ref.trim();
}

function pathOfEntityId(entityId: string): string | undefined {
  if (entityId.startsWith("file:")) {
    return entityId.slice("file:".length);
  }
  if (entityId.startsWith("symbol:")) {
    const hash = entityId.indexOf("#");
    return hash > 0 ? entityId.slice("symbol:".length, hash) : entityId.slice("symbol:".length);
  }
  return undefined;
}
