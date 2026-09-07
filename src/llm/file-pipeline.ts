import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import pLimit from "p-limit";
import { type ImportDeclaration, Node, Project, type SourceFile, SyntaxKind } from "ts-morph";
import { resolveTerms } from "../config.js";
import { buildRuntimeContext } from "../context/runtime-context-builder.js";
import { buildFileDag } from "../graph/file-dag.js";
import { BLOCK_IDS, type BlockId } from "../markdown/block-ids.js";
import type { CodeloreService } from "../service/codelore-service.js";
import type {
  CodeEntity,
  CodeIndex,
  DocSection,
  ProjectIndex,
  RewriteSectionInput,
  RuntimeHit,
  SectionContext,
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import { completeAndParse } from "./complete-and-parse.js";
import {
  allowedRefsForSection,
  buildEntityNameToIds,
  type DocViolation,
  invalidRefsForBlock,
  type ValidateFileWriteInput,
  validateFileWrite,
} from "./doc-validator.js";
import {
  buildVerifyRequest,
  type ContradictedClaim,
  parseVerifyResponse,
  VERIFY_SOURCE_CAP,
  type VerifySectionInput,
} from "./doc-verifier.js";
import { planWriterChunks, type WriterChunk } from "./file-chunks.js";
import {
  buildFileWriteRequest,
  type DependencyDoc,
  type FileWriteCaller,
  type FileWriteResult,
  type FileWriteSection,
  parseFileWriteResponse,
  repairResponseSchema,
  writeRequestOverheadChars,
} from "./file-writer.js";
import {
  buildGenerationDebugEntry,
  type GenerationDebugError,
  type GenerationDebugLlmPipelineInput,
  writeGenerationDebug,
} from "./generation-debug.js";
import type { ChatCompletionInput, ChatCompletionProvider } from "./provider.js";
import { stripComments } from "./strip-comments.js";
import { collectTypeContext } from "./type-context.js";

// Slow providers truncate long streams under load; two parse retries ride it out.
const DEFAULT_MAX_RETRIES = 2;
const CALLER_BODY_CAP = 4_000;
const SECTION_CALLER_BODIES_CAP = 8_000;
const VERIFY_HELPER_CONTEXT_CAP = 1_200;
const VERIFY_HELPER_CONTEXT_DEPTH = 2;
/**
 * Blocks a section exposes to its dependents as dependency docs. They describe the
 * entity itself, are generated from its own code (no dependency-doc prose), and are
 * the only blocks that propagate up the import graph.
 */
export const PROPAGATING_BLOCKS: BlockId[] = ["purpose", "responsibility", "invariants"];
/** Blocks that may consume dependency docs but are never read as one — terminal, they never propagate. */
export const TERMINAL_BLOCKS: BlockId[] = BLOCK_IDS.filter((id) => !PROPAGATING_BLOCKS.includes(id));
const DEP_DOC_FILE_CAP = 2_500;
const DEP_DOCS_TOTAL_CAP = 15_000;

export type GenerationPhase = "propagating" | "terminal";

function blockSetForPhase(phase: GenerationPhase | undefined): Set<BlockId> | undefined {
  if (phase === "propagating") {
    return new Set(PROPAGATING_BLOCKS);
  }
  if (phase === "terminal") {
    return new Set(TERMINAL_BLOCKS);
  }
  return undefined;
}

export interface FileGenerationInput {
  service: CodeloreService;
  index: ProjectIndex;
  files: string[];
  sectionIds: string[];
  intent?: string;
  provider: ChatCompletionProvider;
  /** Fact-check provider (verification, factRecheck). Defaults to `provider`. */
  verifyProvider?: ChatCompletionProvider;
  runId: string;
  command: string;
  /**
   * Which block class to generate. "propagating" writes purpose/responsibility/
   * invariants from the entity's own code with no dependency docs; "terminal" writes
   * the rest with dependency docs in context. Omitted = both, with dependency docs
   * (legacy single-pass behavior).
   */
  phase?: GenerationPhase;
  /** Optional per-section block targets for block-level stale refills. */
  targetBlocksBySection?: ReadonlyMap<string, BlockId[]>;
  maxRetries?: number;
}

export interface FileGenerationOutcome {
  rewrites: RewriteSectionInput[];
  writtenSections: Array<{ sectionId: string; docPath: string; blocks: BlockId[] }>;
  keptBlocks: Array<{ sectionId: string; blockId: BlockId; reason: string }>;
  reviewSections: Array<{ sectionId: string; reason: string }>;
  debugPathByDoc: Record<string, string>;
}

export async function generateFileGroup(input: FileGenerationInput): Promise<FileGenerationOutcome> {
  const { service, index, files, provider, intent } = input;
  const verifyProvider = input.verifyProvider ?? provider;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;

  const sources = await Promise.all(
    files.map(async (path) => ({ path, source: await readFile(join(service.config.rootDir, path), "utf8") }))
  );
  const sourceByPath = new Map(sources.map((file) => [file.path, file.source]));

  const phaseBlocks = blockSetForPhase(input.phase);
  const sections: FileWriteSection[] = [];
  const docSections = new Map<string, DocSection>();
  for (const sectionId of input.sectionIds) {
    const docSection = index.docs.sections[sectionId];
    if (!docSection) {
      continue;
    }
    const requestedTargets = input.targetBlocksBySection?.get(sectionId);
    const context = await service.getSectionContext(sectionId, undefined, {
      includeProjectContext: false,
      ...(requestedTargets ? { targets: requestedTargets } : {}),
    });
    const targets = phaseBlocks ? context.targets.filter((block) => phaseBlocks.has(block)) : context.targets;
    if (targets.length === 0) {
      continue;
    }
    docSections.set(sectionId, docSection);
    const ownerPath = context.owns[0]?.path;
    const fileSource = ownerPath ? sourceByPath.get(ownerPath) : undefined;
    sections.push(await fileWriteSection(service, index, { ...context, targets }, docSection, fileSource));
  }
  if (sections.length === 0) {
    return emptyOutcome();
  }

  // Propagating blocks describe the entity from its own code only — withholding
  // dependency docs is what keeps them from propagating up the import graph.
  const dependencyDocs = input.phase === "propagating" ? [] : collectDependencyDocs(index, files);
  const projectContext = await service.getProjectContext();
  const language = service.config.docs.language;
  // Terms are module-scoped: only the groups whose glob covers this group's files reach the prompt.
  const terms = language ? resolveTerms(service.config.docs, files, language) : [];
  const overheadChars = writeRequestOverheadChars({
    dependencyDocs,
    projectContext: projectContext?.text,
    terms,
    language,
    intent,
  });
  const chunks = planWriterChunks({
    sources,
    sections,
    code: index.code,
    budget: provider.writerBudget,
    overheadChars,
  });

  const llmStages: GenerationDebugLlmPipelineInput = {};
  const debugSink = createDebugSink({ input, sections, dependencyDocs, llmStages, docSections });

  let result: FileWriteResult = {};
  const violations: DocViolation[] = [];
  const remainingViolations: DocViolation[] = [];
  // Chunks cover disjoint sections, so they can run concurrently; the provider
  // is the bottleneck on slow streams, not ordering.
  const limit = pLimit(service.config.llm.concurrency);
  const chunkOutcomes = await Promise.all(
    chunks.map((chunk) =>
      limit(() =>
        generateChunk({
          chunk,
          files,
          sources,
          index,
          rootDir: service.config.rootDir,
          verifyTypeContext: service.config.llm.verifyTypeContext,
          dependencyDocs,
          projectContext: projectContext?.text,
          terms,
          language,
          intent,
          provider,
          verifyProvider,
          maxRetries,
          llmStages,
          debugSink,
        })
      )
    )
  );
  for (const chunkOutcome of chunkOutcomes) {
    result = mergeRepairedBlocks(result, chunkOutcome.result);
    violations.push(...chunkOutcome.violations);
    remainingViolations.push(...chunkOutcome.remainingViolations);
  }

  const outcome = buildOutcome(result, sections, docSections);
  const debugPathByDoc = await debugSink.writeFinal({
    violations,
    violationsAfterRepair: remainingViolations,
    writtenBlocks: Object.fromEntries(outcome.writtenSections.map((section) => [section.sectionId, section.blocks])),
    keptBlocks: outcome.keptBlocks,
  });
  return { ...outcome, debugPathByDoc };
}

async function generateChunk(args: {
  chunk: WriterChunk;
  files: string[];
  /** Original (unspliced) file sources for entity-range slicing during verification. */
  sources: Array<{ path: string; source: string }>;
  index: ProjectIndex;
  rootDir: string;
  verifyTypeContext: boolean;
  dependencyDocs: DependencyDoc[];
  projectContext?: string;
  terms: string[];
  language?: string;
  intent?: string;
  provider: ChatCompletionProvider;
  verifyProvider: ChatCompletionProvider;
  maxRetries: number;
  llmStages: GenerationDebugLlmPipelineInput;
  debugSink: { writeError: (extra: { error?: GenerationDebugError }) => Promise<Record<string, string>> };
}): Promise<{ result: FileWriteResult; violations: DocViolation[]; remainingViolations: DocViolation[] }> {
  const { chunk, provider, llmStages, debugSink, maxRetries } = args;
  const sections = compactChunkCallers(chunk.sections);
  const stageSuffix = chunk.parts > 1 ? ` ${chunk.part}/${chunk.parts}` : "";
  const generationStage = `fileGeneration${stageSuffix}`;

  const request = buildFileWriteRequest({
    files: chunk.files,
    sections,
    dependencyDocs: args.dependencyDocs,
    projectContext: args.projectContext,
    terms: args.terms,
    language: args.language,
    intent: args.intent,
  });

  let result = await completeAndParse({
    provider,
    llmStages,
    stageName: generationStage,
    request,
    parse: (content) => parseFileWriteResponse(content, sections),
    writeDebug: debugSink.writeError,
    requestErrorStage: "file_generation_request",
    parseErrorStage: "file_generation_parse",
    maxRetries,
  });

  const entityNameToIds = buildEntityNameToIds(args.index.code.entities);
  const validationInput = (candidate: FileWriteResult) => ({
    result: candidate,
    sections,
    groupFiles: args.files,
    knownEntityIds: new Set(Object.keys(args.index.code.entities)),
    knownFiles: new Set(Object.keys(args.index.code.fileToEntities)),
    dependencyDocPaths: new Set(args.dependencyDocs.map((doc) => doc.sourcePath)),
    entityNameToIds,
    fileExists: (relativePath: string) => existsSync(join(args.rootDir, relativePath)),
  });

  // Deterministic ref cleanup first: a stray ref (unknown/outside-context/wrong
  // role) is structured metadata — drop exactly it and keep the block, rather
  // than sending the block to a repair the model may fail and losing it to review.
  result = stripInvalidRefs(result, sections, validationInput(result));
  const violations = validateFileWrite(validationInput(result));
  let remainingViolations = violations;
  if (violations.length > 0) {
    const repaired = await completeAndParse({
      provider,
      llmStages,
      stageName: `repair${stageSuffix}`,
      request: buildRepairRequest({
        sections,
        result,
        violations,
        refContext: {
          dependencyDocPaths: new Set(args.dependencyDocs.map((doc) => doc.sourcePath)),
          groupFiles: args.files,
        },
      }),
      parse: (content) => parseFileWriteResponse(content, sections, { requireCompleteness: false }),
      writeDebug: debugSink.writeError,
      requestErrorStage: "repair_request",
      parseErrorStage: "repair_parse",
      maxRetries,
    });
    result = mergeRepairedBlocks(result, repaired);
    remainingViolations = validateFileWrite(validationInput(result));
    result = dropViolatingBlocks(result, remainingViolations);
  }

  const verified = await verifyChunkFacts({
    sections,
    result,
    sources: args.sources,
    code: args.index.code,
    rootDir: args.rootDir,
    verifyTypeContext: args.verifyTypeContext,
    dependencyDocs: args.dependencyDocs,
    groupFiles: args.files,
    provider,
    verifyProvider: args.verifyProvider,
    maxRetries,
    stageSuffix,
    llmStages,
    debugSink,
  });
  result = verified.result;
  if (verified.factViolations.length > 0) {
    // Fact repair may have introduced fresh ref violations; the deterministic
    // check is cheap, run it on the final result.
    const refViolations = validateFileWrite(validationInput(result));
    result = dropViolatingBlocks(result, refViolations);
    remainingViolations = [...remainingViolations, ...verified.remaining, ...refViolations];
  }

  return { result, violations: [...violations, ...verified.factViolations], remainingViolations };
}

function emptyOutcome(): FileGenerationOutcome {
  return {
    rewrites: [],
    writtenSections: [],
    keptBlocks: [],
    reviewSections: [],
    debugPathByDoc: {},
  };
}

function buildOutcome(
  result: FileWriteResult,
  sections: FileWriteSection[],
  docSections: Map<string, DocSection>
): Omit<FileGenerationOutcome, "debugPathByDoc"> {
  const rewrites: RewriteSectionInput[] = [];
  const writtenSections: FileGenerationOutcome["writtenSections"] = [];
  const keptBlocks: FileGenerationOutcome["keptBlocks"] = [];
  const reviewSections: FileGenerationOutcome["reviewSections"] = [];

  for (const section of sections) {
    const docSection = docSections.get(section.sectionId);
    if (!docSection) {
      continue;
    }
    const written = result[section.sectionId] ?? {};
    const blocks: RewriteSectionInput["generatedBlocks"] = {};
    const writtenIds: BlockId[] = [];
    const missing: BlockId[] = [];

    for (const blockId of section.targetBlocks) {
      const block = written[blockId];
      if (block) {
        const { refs: _refs, ...generated } = block;
        blocks[blockId] = generated;
        writtenIds.push(blockId);
        continue;
      }
      const existing = docSection.blocks.find((entry) => entry.id === blockId);
      if (existing && existing.body.trim() !== "") {
        // Never replace written documentation with nothing.
        keptBlocks.push({
          sectionId: section.sectionId,
          blockId,
          reason: "generation produced no valid replacement; previous text kept",
        });
      } else {
        missing.push(blockId);
      }
    }

    if (writtenIds.length > 0) {
      rewrites.push({ sectionId: section.sectionId, generatedBlocks: blocks, showFiltered: true });
      writtenSections.push({ sectionId: section.sectionId, docPath: docSection.docPath, blocks: writtenIds });
    }
    if (missing.length > 0 && writtenIds.length === 0) {
      reviewSections.push({
        sectionId: section.sectionId,
        reason: `Generation produced no blocks for: ${missing.join(", ")}.`,
      });
    }
  }

  return {
    rewrites,
    writtenSections,
    keptBlocks,
    reviewSections,
  };
}

export function dependencyDocsFingerprint(dependencyDocs: DependencyDoc[]): string {
  return sha256(JSON.stringify(dependencyDocs));
}

/** Rendered dependency docs for every file the group imports, capped. */
export function collectDependencyDocs(index: ProjectIndex, files: string[]): DependencyDoc[] {
  const dag = buildFileDag(index.code);
  const group = new Set(files);
  const depFiles = new Set<string>();
  for (const file of files) {
    for (const dep of dag.get(file) ?? []) {
      if (!group.has(dep)) {
        depFiles.add(dep);
      }
    }
  }

  const sectionsByPath = new Map<string, DocSection[]>();
  for (const section of Object.values(index.docs.sections)) {
    const ownerId = section.owns[0];
    const ownerPath = ownerId ? index.code.entities[ownerId]?.path : undefined;
    if (!ownerPath) {
      continue;
    }
    const bucket = sectionsByPath.get(ownerPath) ?? [];
    bucket.push(section);
    sectionsByPath.set(ownerPath, bucket);
  }

  const docs: DependencyDoc[] = [];
  let totalChars = 0;
  for (const depFile of [...depFiles].sort()) {
    const depSections = sectionsByPath.get(depFile) ?? [];
    const doc = dependencyDocForFile(depFile, depSections);
    if (!doc) {
      continue;
    }
    const size = JSON.stringify(doc.sections).length;
    if (totalChars + size > DEP_DOCS_TOTAL_CAP) {
      break;
    }
    totalChars += size;
    docs.push(doc);
  }
  return docs;
}

function dependencyDocForFile(depFile: string, sections: DocSection[]): DependencyDoc | undefined {
  const docSections: DependencyDoc["sections"] = [];
  let used = 0;
  for (const section of sections) {
    const blocks: Array<{ blockId: BlockId; body: string }> = [];
    for (const blockId of PROPAGATING_BLOCKS) {
      const block = section.blocks.find((entry) => entry.id === blockId);
      if (!block || !block.rendered || block.body.trim() === "") {
        continue;
      }
      if (used + block.body.length > DEP_DOC_FILE_CAP) {
        continue;
      }
      used += block.body.length;
      blocks.push({ blockId, body: block.body });
    }
    if (blocks.length > 0) {
      docSections.push({ heading: section.heading, blocks });
    }
  }
  if (docSections.length === 0) {
    return undefined;
  }
  return { sourcePath: depFile, sections: docSections };
}

async function fileWriteSection(
  service: CodeloreService,
  index: ProjectIndex,
  context: SectionContext,
  docSection: DocSection,
  fileSource?: string
): Promise<FileWriteSection> {
  const entity = context.owns[0];
  const callers = await collectCallers(service, context, index);
  // The entity's own reachable private same-file helpers are legitimate refs (they
  // are its callees) but are not indexed, so a ref to one would fail validation as
  // unknown. Expose them as deps: refs validate, and — being reachable *from this
  // entity* — a sibling's helper is not admitted, keeping the own-callee distinction.
  const helperDepIds = entity && fileSource ? privateHelperDepIds(fileSource, entity, index.code) : [];
  // A module section documents what its file's entities compose into, so those
  // entities are its legitimate refs; without them the validator rejects every
  // mention of the module's own symbols.
  const ownModuleEntityIds =
    entity?.type === "file" ? (index.code.fileToEntities[entity.path] ?? []).filter((id) => id !== entity.id) : [];
  return {
    sectionId: docSection.id,
    heading: docSection.heading,
    entity: entity
      ? { id: entity.id, name: entity.name, type: entity.type, signature: entity.signature }
      : { id: docSection.id, name: docSection.heading, type: "file", signature: docSection.heading },
    allowedBlocks: context.allowedBlocks,
    targetBlocks: context.targets,
    existingBlocks: docSection.blocks
      .filter((block) => block.body.trim() !== "")
      .map((block) => ({
        blockId: block.id as BlockId,
        body: block.body,
        ...(block.staleReason ? { staleReason: block.staleReason } : {}),
      })),
    callers,
    dependencyEntityIds: [...context.depends.map((dep) => dep.id), ...helperDepIds, ...ownModuleEntityIds],
  };
}

async function collectCallers(
  service: CodeloreService,
  context: SectionContext,
  index: ProjectIndex
): Promise<FileWriteCaller[]> {
  const targetEntityId = context.owns[0]?.id;
  let runtimeHits: RuntimeHit[] = [];
  if (targetEntityId) {
    try {
      const runtime = await buildRuntimeContext({
        targetEntityId,
        codeIndex: index.code,
        rootDir: service.config.rootDir,
      });
      runtimeHits = runtime.hits;
    } catch {
      // runtime context is supplementary; never fail generation over it
    }
  }

  const callerIds = new Set<string>();
  const staticIds = new Set<string>();
  for (const usage of context.directUsages) {
    callerIds.add(usage.id);
    staticIds.add(usage.id);
  }
  // A file-entity usage means the call sits in the caller file's un-indexed
  // code; resolve it to the indexed symbols that reach the call site so the
  // writer gets the true callers and their names pass validation. The file
  // caller itself is dropped by dropEnclosingCallers once a resolved symbol
  // of the same file is present.
  const target = context.owns[0];
  if (target) {
    for (const usage of context.directUsages) {
      if (!usage.id.startsWith("file:")) {
        continue;
      }
      try {
        const callerFile = (await service.readCodeEntity(usage.id)) as { code: string };
        const callerPath = usage.id.slice("file:".length);
        for (const id of fileCallerSymbolIds(callerFile.code, callerPath, target, index.code)) {
          callerIds.add(id);
          staticIds.add(id);
        }
      } catch {
        // attribution is supplementary; the file-entity caller stays as before
      }
    }
  }
  for (const hit of runtimeHits) {
    callerIds.add(hit.entityId);
  }

  const callerCode: Array<CodeEntity & { code: string }> = [];
  for (const id of callerIds) {
    if (!index.code.entities[id]) {
      continue;
    }
    try {
      callerCode.push((await service.readCodeEntity(id)) as CodeEntity & { code: string });
    } catch {
      // entity may be a file-level fallback or unreadable; skip silently
    }
  }

  const hitsById = new Map<string, RuntimeHit[]>();
  for (const hit of runtimeHits) {
    const bucket = hitsById.get(hit.entityId) ?? [];
    bucket.push(hit);
    hitsById.set(hit.entityId, bucket);
  }

  return dropEnclosingCallers(callerCode).map((caller) => {
    const hits = hitsById.get(caller.id) ?? [];
    const code = stripComments(caller.code);
    return {
      id: caller.id,
      path: caller.path,
      signature: caller.signature,
      kind: staticIds.has(caller.id) ? ("static" as const) : ("runtime" as const),
      body: code.length > CALLER_BODY_CAP ? `${code.slice(0, CALLER_BODY_CAP)}\n// … truncated` : code,
      ...(hits.length > 0
        ? {
            runtimeEvidence: hits.map((hit) => ({
              literal: hit.literalValue,
              syntaxRole: hit.syntaxRole,
              callsite: hit.callsite,
            })),
          }
        : {}),
    };
  });
}

// The index reports usage at every granularity (file ⊃ class ⊃ method), so the
// same call site arrives as up to three callers; keep only the innermost one.
function dropEnclosingCallers(callers: Array<CodeEntity & { code: string }>): Array<CodeEntity & { code: string }> {
  return callers.filter(
    (caller) =>
      !callers.some(
        (other) =>
          other.id !== caller.id &&
          other.path === caller.path &&
          caller.range.startOffset <= other.range.startOffset &&
          caller.range.endOffset >= other.range.endOffset &&
          other.range.endOffset - other.range.startOffset < caller.range.endOffset - caller.range.startOffset
      )
  );
}

/**
 * Caller bodies dominate the sections JSON, so each section gets a total body
 * budget (runtime-evidence callers first) and a body is sent at most once per
 * chunk; the remaining callers keep id/signature/runtimeEvidence only.
 */
export function compactChunkCallers(sections: FileWriteSection[]): FileWriteSection[] {
  const sent = new Set<string>();
  return sections.map((section) => {
    const withBody = new Set<string>();
    let budget = SECTION_CALLER_BODIES_CAP;
    const prioritized = [...section.callers].sort(
      (left, right) => Number(right.runtimeEvidence !== undefined) - Number(left.runtimeEvidence !== undefined)
    );
    for (const caller of prioritized) {
      if (caller.body === undefined || sent.has(caller.id) || caller.body.length > budget) {
        continue;
      }
      budget -= caller.body.length;
      withBody.add(caller.id);
      sent.add(caller.id);
    }
    if (withBody.size === section.callers.length) {
      return section;
    }
    return {
      ...section,
      callers: section.callers.map((caller) => {
        if (withBody.has(caller.id)) {
          return caller;
        }
        const { body: _body, ...rest } = caller;
        return rest;
      }),
    };
  });
}

/**
 * Fact-check pass: the writer synthesizes under broad context and can emit
 * plausible claims the code contradicts; the verifier gets a narrow task —
 * each section's own source plus its fresh blocks. Contradicted statements get
 * one repair round; claims still contradicted after it drop the block (the
 * outcome keeps previous text and marks review, same as ref violations).
 */
export async function verifyChunkFacts(args: {
  sections: FileWriteSection[];
  result: FileWriteResult;
  sources: Array<{ path: string; source: string }>;
  code: CodeIndex;
  rootDir: string;
  /** Include imported type declarations in the verification context. */
  verifyTypeContext: boolean;
  dependencyDocs: DependencyDoc[];
  groupFiles: string[];
  provider: ChatCompletionProvider;
  /** Fact-check provider for verification/factRecheck; factRepair stays on `provider`. */
  verifyProvider?: ChatCompletionProvider;
  maxRetries: number;
  stageSuffix: string;
  llmStages: GenerationDebugLlmPipelineInput;
  debugSink: { writeError: (extra: { error?: GenerationDebugError }) => Promise<Record<string, string>> };
}): Promise<{ result: FileWriteResult; factViolations: DocViolation[]; remaining: DocViolation[] }> {
  const verifySections = buildVerifySections(args.sections, args.result, args.sources, args.code);
  if (verifySections.length === 0) {
    return { result: args.result, factViolations: [], remaining: [] };
  }

  const typeContext = args.verifyTypeContext
    ? await collectTypeContext({ sections: verifySections, code: args.code, rootDir: args.rootDir })
    : [];
  const verifyProvider = args.verifyProvider ?? args.provider;
  const verifyCall = (stageName: string, sections: VerifySectionInput[]) =>
    completeAndParse({
      provider: verifyProvider,
      llmStages: args.llmStages,
      stageName,
      request: buildVerifyRequest({ sections, dependencyDocs: args.dependencyDocs, typeContext }),
      parse: (content) => parseVerifyResponse(content, sections),
      writeDebug: args.debugSink.writeError,
      requestErrorStage: "verification_request",
      parseErrorStage: "verification_parse",
      maxRetries: args.maxRetries,
    });

  const claims = await verifyCall(`verification${args.stageSuffix}`, verifySections);
  if (claims.length === 0) {
    return { result: args.result, factViolations: [], remaining: [] };
  }

  const factViolations = claims.map(claimViolation);
  const repaired = await completeAndParse({
    provider: args.provider,
    llmStages: args.llmStages,
    stageName: `factRepair${args.stageSuffix}`,
    request: buildRepairRequest({
      sections: args.sections,
      result: args.result,
      violations: factViolations,
      refContext: {
        dependencyDocPaths: new Set(args.dependencyDocs.map((doc) => doc.sourcePath)),
        groupFiles: args.groupFiles,
      },
    }),
    parse: (content) => parseFileWriteResponse(content, args.sections, { requireCompleteness: false }),
    writeDebug: args.debugSink.writeError,
    requestErrorStage: "repair_request",
    parseErrorStage: "repair_parse",
    maxRetries: args.maxRetries,
  });

  let result = mergeRepairedBlocks(args.result, repaired);
  // The recheck below only sees re-emitted blocks; a flagged block that repair
  // did not return would otherwise keep its contradicted text. Drop it.
  const unrepaired = factViolations.filter(
    (violation) => repaired[violation.sectionId]?.[violation.blockId] === undefined
  );
  result = dropViolatingBlocks(result, unrepaired);
  const recheckSections = buildVerifySections(args.sections, repaired, args.sources, args.code);
  let remaining: DocViolation[] = unrepaired;
  if (recheckSections.length > 0) {
    const remainingClaims = await verifyCall(`factRecheck${args.stageSuffix}`, recheckSections);
    remaining = [...unrepaired, ...remainingClaims.map(claimViolation)];
    result = dropViolatingBlocks(result, remaining);
  }
  return { result, factViolations, remaining };
}

/** Sections that produced blocks, each with its entity's own source slice (capped). */
export function buildVerifySections(
  sections: FileWriteSection[],
  result: FileWriteResult,
  sources: Array<{ path: string; source: string }>,
  code: CodeIndex
): VerifySectionInput[] {
  const sourceByPath = new Map(sources.map((file) => [file.path, file.source]));
  const verifySections: VerifySectionInput[] = [];
  for (const section of sections) {
    const blocks = Object.entries(result[section.sectionId] ?? {})
      .filter((entry): entry is [string, NonNullable<FileWriteResult[string][BlockId]>] => entry[1] !== undefined)
      .map(([blockId, block]) => ({ blockId: blockId as BlockId, text: block.text }));
    if (blocks.length === 0) {
      continue;
    }
    const entity = code.entities[section.entity.id];
    const fileSource = entity ? sourceByPath.get(entity.path) : undefined;
    if (!entity || fileSource === undefined) {
      continue;
    }
    verifySections.push({
      sectionId: section.sectionId,
      entityId: section.entity.id,
      source: verificationSource(fileSource, entity, code),
      blocks,
    });
  }
  return verifySections;
}

function verificationSource(fileSource: string, entity: CodeEntity, code: CodeIndex): string {
  // Comments are unverified prose: the verifier must check claims against
  // executable code only, or it "confirms" the doc against the same comment
  // that misled the writer.
  const primary = stripComments(fileSource.slice(entity.range.startOffset, entity.range.endOffset));
  const sourceFile = sourceFileFromText(entity.path, fileSource);
  const helperContext = sameFileHelperContext(sourceFile, fileSource, entity, code);
  // Names-only inventory of the whole file so existence/location claims
  // ("X is defined in this file") are verifiable even when X sits outside the
  // sliced entity body and the reachable-helper budget — the exact false
  // "contradiction" the verifier otherwise emits.
  const outline = fileOutline(sourceFile);
  return composeVerifySource(primary, helperContext, outline);
}

/** Compact names-only inventory of every top-level declaration in the file. */
function fileOutline(sourceFile: SourceFile): string {
  const functions: string[] = [];
  const classes: string[] = [];
  const values: string[] = [];
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name) {
      functions.push(name);
    }
  }
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (name) {
      classes.push(name);
    }
  }
  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      values.push(declaration.getName());
    }
  }
  const parts = [
    functions.length > 0 ? `functions: ${functions.join(", ")}` : "",
    classes.length > 0 ? `classes: ${classes.join(", ")}` : "",
    values.length > 0 ? `values: ${values.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

/**
 * Reachable same-file context for verifier claims that delegate into private
 * helpers. It includes the file header plus only private top-level function-like
 * declarations reached from the entity by direct calls, bounded by depth and size.
 */
function sameFileHelperContext(
  sourceFile: SourceFile,
  fileSource: string,
  entity: CodeEntity,
  code: CodeIndex
): string {
  const reachable = reachablePrivateHelpers(sourceFile, fileSource, entity, code);
  const usedNames = identifierNamesInRanges(sourceFile, [
    { startOffset: entity.range.startOffset, endOffset: entity.range.endOffset },
    ...reachable,
  ]);
  const header = relevantHeader(sourceFile, fileSource, entity.path, code, usedNames);
  return capHelperContext([header, ...reachable.map((helper) => stripComments(helper.source).trim())].filter(Boolean));
}

/** Private top-level helpers reachable from the entity by direct calls (depth-bounded). */
function reachablePrivateHelpers(
  sourceFile: SourceFile,
  fileSource: string,
  entity: Pick<CodeEntity, "path" | "range">,
  code: CodeIndex
): PrivateHelper[] {
  const helpers = privateTopLevelHelpers(sourceFile, fileSource, entity.path, code);
  const directCalls = calledNamesInRange(sourceFile, entity.range.startOffset, entity.range.endOffset);
  return reachableHelpers(sourceFile, helpers, directCalls);
}

/**
 * Synthetic ids (`symbol:<path>#<name>`) for the entity's reachable private
 * same-file helpers — the id form the writer already emits when it references
 * them. Added to the section's dependencyEntityIds so those refs validate.
 */
export function privateHelperDepIds(
  fileSource: string,
  entity: Pick<CodeEntity, "path" | "range">,
  code: CodeIndex
): string[] {
  const sourceFile = sourceFileFromText(entity.path, fileSource);
  return reachablePrivateHelpers(sourceFile, fileSource, entity, code).map(
    (helper) => `symbol:${entity.path}#${helper.name}`
  );
}

/**
 * Indexed symbols of `callerPath` that reach a call of `target` made inside the
 * caller file's un-indexed top-level helpers. The index attributes such a call
 * to the file entity only (private helpers are not indexed), so the true callers
 * are invisible to the writer and the validator rejects their names. This walks
 * the caller file's local call graph from the call site upward:
 * `renderGraphTree → collectNodes → generationWaves` attributes the usage to
 * `renderGraphTree`. Calls at module top level (outside any helper) resolve to
 * nothing — the file-entity caller stays for those.
 */
export function fileCallerSymbolIds(
  callerSource: string,
  callerPath: string,
  target: Pick<CodeEntity, "path" | "name">,
  code: CodeIndex
): string[] {
  const sourceFile = sourceFileFromText(callerPath, callerSource);
  const indexedRanges = indexedSymbolRanges(callerPath, code);
  const offsets = targetCallOffsets(sourceFile, callerPath, target).filter(
    (offset) => !indexedRanges.some((range) => offset >= range.startOffset && offset < range.endOffset)
  );
  if (offsets.length === 0) {
    return [];
  }

  const helpers = privateTopLevelHelpers(sourceFile, callerSource, callerPath, code);
  const hit = new Set<string>();
  for (const helper of helpers.values()) {
    if (offsets.some((offset) => offset >= helper.startOffset && offset < helper.endOffset)) {
      hit.add(helper.name);
    }
  }
  if (hit.size === 0) {
    return [];
  }

  // Reverse reachability to a fixpoint: a helper that calls a hit helper is on
  // the path from an indexed symbol to the call site. Exact, no depth cap —
  // a cap would silently drop true callers.
  let grew = true;
  while (grew) {
    grew = false;
    for (const helper of helpers.values()) {
      if (hit.has(helper.name)) {
        continue;
      }
      const calls = calledNamesInRange(sourceFile, helper.startOffset, helper.endOffset);
      if ([...hit].some((name) => calls.has(name))) {
        hit.add(helper.name);
        grew = true;
      }
    }
  }

  const ids: string[] = [];
  for (const id of code.fileToEntities[callerPath] ?? []) {
    if (!id.startsWith("symbol:")) {
      continue;
    }
    const range = code.entities[id]?.range;
    if (!range) {
      continue;
    }
    const calls = calledNamesInRange(sourceFile, range.startOffset, range.endOffset);
    if ([...hit].some((name) => calls.has(name))) {
      ids.push(id);
    }
  }
  return ids.sort();
}

/**
 * Offsets of calls in the caller file that resolve to `target` via its import
 * bindings — named imports (aliases included) and namespace property access.
 * Symbol resolution keeps shadowing locals and same-name members of other
 * objects from matching; a call the file's imports cannot explain is not a
 * target call.
 */
function targetCallOffsets(
  sourceFile: SourceFile,
  callerPath: string,
  target: Pick<CodeEntity, "path" | "name">
): number[] {
  const offsets: number[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isIdentifier(callee) && isTargetNamedImport(callee, callerPath, target)) {
      offsets.push(call.getStart());
      continue;
    }
    if (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === target.name &&
      Node.isIdentifier(callee.getExpression()) &&
      isTargetNamespaceImport(callee.getExpression(), callerPath, target.path)
    ) {
      offsets.push(call.getStart());
    }
  }
  return offsets;
}

function isTargetNamedImport(identifier: Node, callerPath: string, target: Pick<CodeEntity, "path" | "name">): boolean {
  for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isImportSpecifier(declaration)) {
      continue;
    }
    if (declaration.getName() !== target.name) {
      continue;
    }
    const specifier = declaration.getImportDeclaration().getModuleSpecifierValue();
    if (specifierResolvesTo(specifier, callerPath, target.path)) {
      return true;
    }
  }
  return false;
}

function isTargetNamespaceImport(identifier: Node, callerPath: string, targetPath: string): boolean {
  for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isNamespaceImport(declaration)) {
      continue;
    }
    const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (importDeclaration && specifierResolvesTo(importDeclaration.getModuleSpecifierValue(), callerPath, targetPath)) {
      return true;
    }
  }
  return false;
}

/** Relative specifiers only — internal deps are always relative; NodeNext names compiled files, so ".js" maps to ".ts". */
function specifierResolvesTo(specifier: string, callerPath: string, targetPath: string): boolean {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(callerPath), specifier));
  return resolved === targetPath || resolved.replace(/\.js$/, ".ts") === targetPath || `${resolved}.ts` === targetPath;
}

interface PrivateHelper {
  name: string;
  startOffset: number;
  endOffset: number;
  source: string;
}

function sourceFileFromText(path: string, source: string): SourceFile {
  const project = new Project({ compilerOptions: { allowJs: true } });
  return project.createSourceFile(path, source, { overwrite: true });
}

function privateTopLevelHelpers(
  sourceFile: SourceFile,
  fileSource: string,
  path: string,
  code: CodeIndex
): Map<string, PrivateHelper> {
  const indexedRanges = indexedSymbolRanges(path, code);
  const helpers = new Map<string, PrivateHelper>();

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) {
      continue;
    }
    addPrivateHelper(helpers, name, fn.getStart(), fn.getEnd(), fileSource, indexedRanges);
  }

  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) {
        continue;
      }
      addPrivateHelper(
        helpers,
        declaration.getName(),
        statement.getStart(),
        statement.getEnd(),
        fileSource,
        indexedRanges
      );
    }
  }

  return helpers;
}

function indexedSymbolRanges(path: string, code: CodeIndex): Array<{ startOffset: number; endOffset: number }> {
  return (code.fileToEntities[path] ?? [])
    .filter((id) => id.startsWith("symbol:"))
    .map((id) => code.entities[id]?.range)
    .filter((range): range is NonNullable<typeof range> => range !== undefined)
    .sort((left, right) => left.startOffset - right.startOffset);
}

function addPrivateHelper(
  helpers: Map<string, PrivateHelper>,
  name: string,
  startOffset: number,
  endOffset: number,
  fileSource: string,
  indexedRanges: Array<{ startOffset: number; endOffset: number }>
): void {
  if (helpers.has(name) || indexedRanges.some((range) => rangesOverlap(startOffset, endOffset, range))) {
    return;
  }
  helpers.set(name, {
    name,
    startOffset,
    endOffset,
    source: fileSource.slice(startOffset, endOffset),
  });
}

function rangesOverlap(
  startOffset: number,
  endOffset: number,
  range: { startOffset: number; endOffset: number }
): boolean {
  return startOffset < range.endOffset && endOffset > range.startOffset;
}

function reachableHelpers(
  sourceFile: SourceFile,
  helpers: ReadonlyMap<string, PrivateHelper>,
  directCalls: ReadonlySet<string>
): PrivateHelper[] {
  const reached: PrivateHelper[] = [];
  const seen = new Set<string>();
  let frontier = [...directCalls].map((name) => ({ name, depth: 1 }));
  while (frontier.length > 0) {
    const nextFrontier: typeof frontier = [];
    for (const { name, depth } of frontier) {
      const helper = helpers.get(name);
      if (!helper || seen.has(name) || depth > VERIFY_HELPER_CONTEXT_DEPTH) {
        continue;
      }
      seen.add(name);
      reached.push(helper);
      if (depth < VERIFY_HELPER_CONTEXT_DEPTH) {
        for (const childName of calledNamesInRange(sourceFile, helper.startOffset, helper.endOffset)) {
          nextFrontier.push({ name: childName, depth: depth + 1 });
        }
      }
    }
    frontier = nextFrontier;
  }
  return reached;
}

function calledNamesInRange(sourceFile: SourceFile, startOffset: number, endOffset: number): Set<string> {
  const names = new Set<string>();
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const start = call.getStart();
    if (start < startOffset || start >= endOffset) {
      continue;
    }
    const expression = call.getExpression();
    if (Node.isIdentifier(expression)) {
      names.add(expression.getText());
    }
  }
  return names;
}

function identifierNamesInRanges(
  sourceFile: SourceFile,
  ranges: Array<{ startOffset: number; endOffset: number }>
): Set<string> {
  const names = new Set<string>();
  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const start = identifier.getStart();
    if (ranges.some((range) => start >= range.startOffset && start < range.endOffset)) {
      names.add(identifier.getText());
    }
  }
  return names;
}

function importLocalNames(declaration: ImportDeclaration): Set<string> {
  const names = new Set<string>();
  const defaultImport = declaration.getDefaultImport();
  if (defaultImport) {
    names.add(defaultImport.getText());
  }
  const namespaceImport = declaration.getNamespaceImport();
  if (namespaceImport) {
    names.add(namespaceImport.getText());
  }
  for (const namedImport of declaration.getNamedImports()) {
    names.add(namedImport.getAliasNode()?.getText() ?? namedImport.getName());
  }
  return names;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function relevantHeader(
  sourceFile: SourceFile,
  fileSource: string,
  path: string,
  code: CodeIndex,
  usedNames: ReadonlySet<string>
): string {
  const firstSymbolStart = indexedSymbolRanges(path, code)[0]?.startOffset ?? 0;
  const parts: string[] = [];
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getStart() < firstSymbolStart && intersects(importLocalNames(declaration), usedNames)) {
      parts.push(declaration.getText());
    }
  }
  for (const statement of sourceFile.getVariableStatements()) {
    if (statement.getStart() >= firstSymbolStart) {
      continue;
    }
    const names = new Set(statement.getDeclarations().map((declaration) => declaration.getName()));
    if (intersects(names, usedNames)) {
      parts.push(fileSource.slice(statement.getStart(), statement.getEnd()));
    }
  }
  return stripComments(parts.join("\n")).trim();
}

function capHelperContext(parts: string[]): string {
  const context = parts.join("\n\n");
  if (context.length <= VERIFY_HELPER_CONTEXT_CAP) {
    return context;
  }
  const truncated = "\n// … helper context truncated";
  return `${context.slice(0, Math.max(0, VERIFY_HELPER_CONTEXT_CAP - truncated.length))}${truncated}`;
}

const VERIFY_OUTLINE_HEADING = "\n\n// --- file outline (all top-level declarations) ---\n";

/**
 * Documented entity slice first, then the always-included file outline (small,
 * reserved before the slice so a large entity never squeezes it out), then the
 * reachable same-file helper context within whatever budget remains.
 */
function composeVerifySource(primary: string, helperContext: string, outline: string): string {
  const outlineSegment = outline.length > 0 ? `${VERIFY_OUTLINE_HEADING}${capOutline(outline)}` : "";
  const primaryBudget = VERIFY_SOURCE_CAP - outlineSegment.length;
  const cappedPrimary =
    primary.length > primaryBudget ? `${primary.slice(0, Math.max(0, primaryBudget))}\n// … truncated` : primary;
  const remaining = VERIFY_SOURCE_CAP - cappedPrimary.length - outlineSegment.length;
  const helperSegment = composeHelperSegment(helperContext, remaining);
  return `${cappedPrimary}${outlineSegment}${helperSegment}`;
}

function capOutline(outline: string): string {
  if (outline.length <= VERIFY_HELPER_CONTEXT_CAP) {
    return outline;
  }
  const truncated = "\n// … outline truncated";
  return `${outline.slice(0, Math.max(0, VERIFY_HELPER_CONTEXT_CAP - truncated.length))}${truncated}`;
}

function composeHelperSegment(helperContext: string, remaining: number): string {
  if (helperContext.length === 0) {
    return "";
  }
  const heading = "\n\n// --- same-file helper context (reachable imports, private functions) ---\n";
  const budget = remaining - heading.length;
  if (budget <= 0) {
    return "";
  }
  const truncated = "\n// … helper context truncated";
  const helperBudget = Math.min(VERIFY_HELPER_CONTEXT_CAP, budget);
  const helpers =
    helperContext.length > helperBudget
      ? `${helperContext.slice(0, Math.max(0, helperBudget - truncated.length))}${truncated}`
      : helperContext;
  return `${heading}${helpers}`;
}

/**
 * Fact-check existing block text against the current dependency docs and return the
 * section ids that were **actually verified and found consistent**. Gates the depDocs
 * cascade: only a section confirmed clean by the verifier is safe to clear with a
 * fingerprint refresh. Sections that could not be verified (no dependency docs to
 * check against, no entity, or empty text) are deliberately omitted — they fall
 * through to normal regeneration rather than being silently cleared.
 */
export async function verifyBlocksAgainstDeps(args: {
  service: CodeloreService;
  index: ProjectIndex;
  targets: Array<{ sectionId: string; blockIds: BlockId[] }>;
  provider: ChatCompletionProvider;
}): Promise<Set<string>> {
  const { service, index, provider } = args;
  const verifiedClean = new Set<string>();

  const byFile = new Map<string, Array<{ sectionId: string; blockIds: BlockId[] }>>();
  for (const target of args.targets) {
    const ownerId = index.docs.sections[target.sectionId]?.owns[0];
    const file = ownerId ? index.code.entities[ownerId]?.path : undefined;
    if (!file) {
      continue;
    }
    const bucket = byFile.get(file) ?? [];
    bucket.push(target);
    byFile.set(file, bucket);
  }

  for (const [file, fileTargets] of byFile) {
    const dependencyDocs = collectDependencyDocs(index, [file]);
    if (dependencyDocs.length === 0) {
      // Nothing to verify against → cannot confirm clean → leave for regeneration.
      continue;
    }
    const fileSource = await readFile(join(service.config.rootDir, file), "utf8");
    const verifySections: VerifySectionInput[] = [];
    for (const { sectionId, blockIds } of fileTargets) {
      const section = index.docs.sections[sectionId];
      const entity = section ? index.code.entities[section.owns[0]] : undefined;
      if (!section || !entity) {
        continue;
      }
      const wanted = new Set(blockIds);
      const blocks = section.blocks
        .filter((block) => wanted.has(block.id as BlockId) && block.body.trim() !== "")
        .map((block) => ({ blockId: block.id as BlockId, text: block.body }));
      if (blocks.length === 0) {
        continue;
      }
      verifySections.push({
        sectionId,
        entityId: entity.id,
        source: verificationSource(fileSource, entity, index.code),
        blocks,
      });
    }
    if (verifySections.length === 0) {
      continue;
    }
    const response = await provider.complete(buildVerifyRequest({ sections: verifySections, dependencyDocs }));
    const contradicted = new Set(parseVerifyResponse(response.content, verifySections).map((claim) => claim.sectionId));
    for (const section of verifySections) {
      if (!contradicted.has(section.sectionId)) {
        verifiedClean.add(section.sectionId);
      }
    }
  }
  return verifiedClean;
}

function claimViolation(claim: ContradictedClaim): DocViolation {
  const evidence = claim.evidence ? `: ${claim.evidence}` : "";
  return {
    sectionId: claim.sectionId,
    blockId: claim.blockId,
    rule: "unsupported_claim",
    detail: `Statement "${claim.statement}" contradicts the code${evidence}. Remove the statement or correct it to match the code.`,
  };
}

/**
 * Repair is deliberately compact: violations are deterministic ref/length
 * problems, so the model gets only the offending blocks, their violations and
 * the allowed-ref lists — not the file sources or dependency docs again.
 */
export function buildRepairRequest(args: {
  sections: FileWriteSection[];
  result: FileWriteResult;
  violations: DocViolation[];
  refContext: { dependencyDocPaths: ReadonlySet<string>; groupFiles: string[] };
}): ChatCompletionInput {
  const sectionById = new Map(args.sections.map((section) => [section.sectionId, section]));
  const grouped = new Map<string, { sectionId: string; blockId: BlockId; violations: string[] }>();
  for (const violation of args.violations) {
    const key = `${violation.sectionId} ${violation.blockId}`;
    const entry = grouped.get(key) ?? { sectionId: violation.sectionId, blockId: violation.blockId, violations: [] };
    entry.violations.push(violation.detail);
    grouped.set(key, entry);
  }

  const allowedRefsBySection: Record<string, string[]> = {};
  const blocks: Array<Record<string, unknown>> = [];
  const schemaPairs: Array<{ sectionId: string; blockId: BlockId }> = [];
  for (const entry of grouped.values()) {
    const section = sectionById.get(entry.sectionId);
    const block = args.result[entry.sectionId]?.[entry.blockId];
    if (!section || !block) {
      continue;
    }
    allowedRefsBySection[entry.sectionId] ??= [...allowedRefsForSection(section, args.refContext)].sort();
    schemaPairs.push({ sectionId: entry.sectionId, blockId: entry.blockId });
    blocks.push({
      sectionId: entry.sectionId,
      blockId: entry.blockId,
      text: block.text,
      refs: block.refs,
      novelFact: block.novelFact,
      informativeness: block.informativeness,
      novelty: block.novelty,
      specificity: block.specificity,
      violations: entry.violations,
    });
  }

  return {
    responseSchema: repairResponseSchema(schemaPairs),
    messages: [
      {
        role: "system",
        content: [
          "You repair documentation blocks that failed deterministic validation.",
          "Return only valid JSON. Do not include Markdown fences.",
          "Do not add new facts: only remove or minimally rephrase the statements named in the violations, fix or drop offending refs, and shorten over-long text.",
          "If a statement cannot be grounded without the offending ref, drop the statement.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Blocks to repair (current content plus the violations found):",
          JSON.stringify(blocks, null, 2),
          "Allowed refs per section — a repaired block's refs must be a subset of its section's list:",
          JSON.stringify(allowedRefsBySection, null, 2),
          "Return JSON with this exact shape, containing ONLY the listed blocks:",
          '{"sections":{"<sectionId>":{"blocks":{"<blockId>":{"text":"...","refs":["..."],"novelFact":"...","informativeness":0.75,"novelty":0.75,"specificity":0.75}}}}}',
          "Each score must be exactly one of: 0, 0.25, 0.5, 0.75, 1. Keep the previous scores unless the repair changed the block's information content.",
        ].join("\n\n"),
      },
    ],
  };
}

/**
 * Drop refs that fail deterministic ref checks from each block, keeping the block
 * and its prose. Refs are metadata; a stray one need not cost the whole block a
 * review round. Prose that genuinely leaned on a dropped ref is still caught by
 * the mentioned-symbol/path checks in the validation that follows.
 */
function stripInvalidRefs(
  result: FileWriteResult,
  sections: FileWriteSection[],
  input: ValidateFileWriteInput
): FileWriteResult {
  const sectionById = new Map(sections.map((section) => [section.sectionId, section]));
  const cleaned: FileWriteResult = {};
  for (const [sectionId, blocks] of Object.entries(result)) {
    const section = sectionById.get(sectionId);
    if (!section) {
      cleaned[sectionId] = blocks;
      continue;
    }
    const cleanedBlocks: FileWriteResult[string] = {};
    for (const [blockId, block] of Object.entries(blocks) as Array<
      [BlockId, NonNullable<FileWriteResult[string][BlockId]>]
    >) {
      const bad = new Set(invalidRefsForBlock(section, blockId, block.refs, input));
      cleanedBlocks[blockId] = bad.size > 0 ? { ...block, refs: block.refs.filter((ref) => !bad.has(ref)) } : block;
    }
    cleaned[sectionId] = cleanedBlocks;
  }
  return cleaned;
}

function mergeRepairedBlocks(base: FileWriteResult, repaired: FileWriteResult): FileWriteResult {
  const merged: FileWriteResult = { ...base };
  for (const [sectionId, blocks] of Object.entries(repaired)) {
    merged[sectionId] = { ...merged[sectionId], ...blocks };
  }
  return merged;
}

function dropViolatingBlocks(result: FileWriteResult, violations: DocViolation[]): FileWriteResult {
  if (violations.length === 0) {
    return result;
  }
  const bad = new Set(violations.map((violation) => `${violation.sectionId}\u0000${violation.blockId}`));
  const cleaned: FileWriteResult = {};
  for (const [sectionId, blocks] of Object.entries(result)) {
    const kept = Object.fromEntries(
      Object.entries(blocks).filter(([blockId]) => !bad.has(`${sectionId}\u0000${blockId}`))
    );
    cleaned[sectionId] = kept as FileWriteResult[string];
  }
  return cleaned;
}

function createDebugSink(args: {
  input: FileGenerationInput;
  sections: FileWriteSection[];
  dependencyDocs: DependencyDoc[];
  llmStages: GenerationDebugLlmPipelineInput;
  docSections: Map<string, DocSection>;
}) {
  const { input, sections, dependencyDocs, llmStages, docSections } = args;
  const docPaths = [...new Set([...docSections.values()].map((section) => section.docPath))];

  const write = async (extra: {
    violations?: DocViolation[];
    violationsAfterRepair?: DocViolation[];
    writtenBlocks?: Record<string, BlockId[]>;
    keptBlocks?: Array<{ sectionId: string; blockId: BlockId; reason: string }>;
    error?: GenerationDebugError;
  }): Promise<Record<string, string>> => {
    const paths: Record<string, string> = {};
    for (const docPath of docPaths) {
      const { debugPath } = await writeGenerationDebug({
        statePath: input.service.docStateStorage.statePathFor(docPath),
        phase: input.phase,
        entry: buildGenerationDebugEntry({
          runId: input.runId,
          timestamp: new Date().toISOString(),
          command: input.command,
          provider: input.provider.name,
          model: input.provider.model,
          docPath,
          files: input.files,
          sections,
          dependencyDocs,
          llmStages,
          ...extra,
        }),
      });
      paths[docPath] = debugPath;
    }
    return paths;
  };

  return {
    writeError: (extra: { error?: GenerationDebugError }) => write(extra),
    writeFinal: write,
  };
}
