import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { loadConfig, resolveTerms } from "../config.js";
import { buildAssignRequest, parseAssignResponse } from "../domains/assign.js";
import { type DomainMap, domainCoverage, fileToDomainSlug } from "../domains/domain-map.js";
import { collectDomainMemberEvidence, domainMemberFingerprint } from "../domains/member-evidence.js";
import { buildPartitionRequest, parsePartitionResponse } from "../domains/partition.js";
import { CodeloreError } from "../errors.js";
import { parseUnifiedDiff } from "../graph/diff.js";
import { buildDomainDag } from "../graph/domain-dag.js";
import { buildFileDag } from "../graph/file-dag.js";
import { getAffectedSectionsForEntities, getImpactForEntity } from "../graph/impact.js";
import { dependencyWaves } from "../graph/waves.js";
import { buildCodeIndex } from "../indexer/code-indexer.js";
import {
  DOMAIN_ID_PREFIX,
  domainIdFor,
  isDomainTierEntity,
  isSourceCodeEntity,
  PROJECT_ID,
} from "../indexer/domain-entities.js";
import { generateDomainDoc } from "../llm/domain-pipeline.js";
import type { BuildDomainWriteRequestInput, DomainWriteDependency, DomainWriteMember } from "../llm/domain-writer.js";
import {
  collectDependencyDocs,
  dependencyDocsFingerprint,
  type FileGenerationOutcome,
  type GenerationPhase,
  generateFileGroup,
  verifyBlocksAgainstDeps,
} from "../llm/file-pipeline.js";
import { type ChatCompletionInput, type ChatCompletionProvider, createConfiguredProvider } from "../llm/provider.js";
import {
  type TranslateBlockInput,
  translateBlocks,
  translationBlockKey,
  translationNeedsWork,
} from "../llm/translator.js";
import { translationSourceFingerprint } from "../markdown/block-facets.js";
import { BLOCK_IDS, type BlockId } from "../markdown/block-ids.js";
import { docResponsibilities } from "../markdown/linkify.js";
import { renderSection } from "../markdown/render-doc.js";
import { DocStateStorage } from "../storage/doc-state-storage.js";
import { JsonStorage } from "../storage/json-storage.js";
import type {
  AffectedSection,
  BlockSkipReason,
  ChangeAnalysis,
  CodeEntity,
  CodeIndex,
  CodeloreConfig,
  DocSection,
  DocState,
  DocStateBlock,
  DocStateSection,
  DocValidationIssue,
  FilteredGeneratedBlock,
  GenerationHistoryEntry,
  PreparedDocSection,
  PrepareInitialDocsInput,
  PrepareInitialDocsResult,
  ProjectContext,
  ProjectIndex,
  RebuildIndexInput,
  RebuildIndexResult,
  RefreshStaleDocsInput,
  RefreshStaleDocsResult,
  RefreshStaleScope,
  RewriteSectionInput,
  SectionContext,
  StaleBlockInfo,
} from "../types.js";
import { reconcileDocStateWithCode } from "./doc-reconcile.js";
import {
  detectStaleBlocks,
  validateBlockQuality,
  validateDependencies,
  validateOwnedEntities,
} from "./doc-validation.js";
import { buildDomainSkeletons, domainDocPath, projectDocPath, tierDocPathForEntity } from "./domain-docs.js";
import { planFileLayout } from "./file-layout.js";
import {
  describeError,
  firstDuplicate,
  groupBy,
  rangesOverlap,
  summarizeCodeEntity,
  summarizeDocSection,
  uniqueEntities,
  uniqueSorted,
} from "./helpers.js";
import { IndexManager, type RebuildIndexesOptions } from "./index-manager.js";
import {
  codeIndexScopeFromPrepareScope,
  docStateSectionForPlannedEntity,
  emptyDocState,
  hasPrepareScope,
  isEntityInPrepareScope,
  isSectionSkeleton,
  normalizePrepareScope,
  preparedDocsResult,
  shouldCreatePage,
  skippedPreparedDocSection,
  withPreservedBlockBodies,
} from "./prepare-docs.js";
import {
  applyRewritesToDoc,
  groupRewritesByDoc,
  normalizeGeneratedRewrite,
  updateStatusFromBlocks,
} from "./section-rewrite.js";
import {
  addTargetBlock,
  buildRewriteContextBundle,
  collectDepDocStaleBlocks,
  collectLanguageStaleBlocks,
  collectMemberDocStaleBlocks,
  collectStaleBlocks,
  collectTombstonedBlocks,
  filterSectionsByScope,
  mergeStaleBlocks,
  refreshStaleResult,
  staleReasonFor,
  targetBlocksFromTombstones,
} from "./stale-detection.js";

const execFileAsync = promisify(execFile);

export interface AnalyzeChangeInput {
  diff?: string;
  changedFiles?: string[];
}

export interface GenerateDocsRuntime {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  command: string;
  runId?: string;
  providerName?: string;
}

export interface GenerateDocsForEntityInput {
  id: string;
  intent?: string;
}

export interface GenerateDocsForScopeInput {
  paths?: string[];
  files?: string[];
  entityIds?: string[];
  intent?: string;
  /**
   * Regenerate every allowed block of every in-scope section, not just drifted
   * ones. Needed to clear a review_needed section whose blocks are all fresh (the
   * stale-gated default path has nothing to target, so its status never updates).
   */
  force?: boolean;
}

export interface FixStaleDocsInput {
  paths?: string[];
  files?: string[];
  sectionIds?: string[];
  intent?: string;
}

export interface GeneratedSectionSummary {
  sectionId: string;
  docPath: string;
  generatedBlocks: string[];
  manualReviewNeeded: boolean;
  generationDebugPath?: string;
}

export interface GenerateDocsResult {
  runId: string;
  provider: string;
  model: string;
  updatedFiles: string[];
  updatedSections: GeneratedSectionSummary[];
  skipped: Array<{ sectionId: string; reason: string }>;
  failed: Array<{ sectionId: string; stage: "plan" | "apply"; error: string; code?: string }>;
}

export class CodeloreService {
  readonly config: CodeloreConfig;
  readonly storage: JsonStorage;
  readonly docStateStorage: DocStateStorage;
  private readonly indexManager: IndexManager;
  private projectContextCache?: { value: ProjectContext | undefined };

  constructor(rootDir: string) {
    this.config = loadConfig(rootDir);
    this.storage = new JsonStorage(this.config);
    this.docStateStorage = new DocStateStorage(this.config);
    this.indexManager = new IndexManager(this.config, this.storage, this.docStateStorage, () => {
      this.projectContextCache = undefined;
    });
  }

  async rebuildIndexes(options: RebuildIndexesOptions = {}): Promise<ProjectIndex> {
    return this.indexManager.rebuild(options);
  }

  async rebuildIndex(input: RebuildIndexInput = {}): Promise<RebuildIndexResult> {
    return summarizeProjectIndex(
      await this.indexManager.rebuild({ persist: true, renderDocs: true }),
      input.verbose ?? false
    );
  }

  private async patchDocIndexForDocs(docPaths: string[]): Promise<void> {
    await this.indexManager.patchDocs(docPaths);
  }

  /**
   * Drop doc state the current code no longer supports before (re)generating:
   * sections whose owning entity was deleted/moved, and blocks an entity no
   * longer allows (block-inclusion narrowed after a refactor). Without this they
   * linger as permanent stale callouts that nothing can refill.
   */
  private async reconcileScopedDocStates(scope: RefreshStaleScope | undefined): Promise<void> {
    const index = await this.loadOrRebuildIndexes();
    const scoped = filterSectionsByScope(Object.values(index.docs.sections), scope, index.code.entities);
    const docPaths = new Set(scoped.map((section) => section.docPath));
    let mutated = false;
    for (const docPath of docPaths) {
      const state = await this.docStateStorage.loadDocState(docPath);
      if (!state || !reconcileDocStateWithCode(state, index.code.entities)) {
        continue;
      }
      mutated = true;
      if (state.sectionOrder.length === 0) {
        await this.docStateStorage.deleteDoc(docPath);
      } else {
        await this.docStateStorage.renderAndPersist(state);
      }
    }
    if (mutated) {
      await this.rebuildIndexes({ renderDocs: false });
    }
  }

  async loadOrRebuildIndexes(): Promise<ProjectIndex> {
    return this.indexManager.loadOrRebuild();
  }

  async analyzeChange(input: AnalyzeChangeInput = {}): Promise<ChangeAnalysis> {
    const index = await this.rebuildIndexes();
    const diff = input.diff ?? (input.changedFiles?.length ? undefined : await this.readGitDiff());
    const changedFiles = uniqueSorted([
      ...(input.changedFiles ?? []),
      ...(diff ? parseUnifiedDiff(diff).map((file) => file.path) : []),
    ]);
    const changedEntities = diff
      ? this.changedEntitiesFromDiff(index, diff)
      : this.changedEntitiesFromFiles(index, changedFiles);
    const affectedSections = getAffectedSectionsForEntities(index.docs, changedEntities);
    const analysis: ChangeAnalysis = {
      id: randomUUID(),
      generatedAt: new Date().toISOString(),
      changedFiles,
      changedEntities,
      affectedSections,
    };

    await this.storage.saveChangeAnalysis(analysis);
    return analysis;
  }

  async getAffectedSections(entityIds: string[]): Promise<AffectedSection[]> {
    const index = await this.loadOrRebuildIndexes();
    return getAffectedSectionsForEntities(index.docs, entityIds);
  }

  async prepareInitialDocs(input: PrepareInitialDocsInput = {}): Promise<PrepareInitialDocsResult> {
    const scope = normalizePrepareScope(input);
    const index = await this.indexManager.buildScopedIndex(codeIndexScopeFromPrepareScope(scope));
    const documentedEntities = new Set(
      Object.values(index.docs.sections)
        .filter((section) => !isSectionSkeleton(section))
        .flatMap((section) => section.owns)
    );
    this.assertKnownEntityIds(index, scope.entityIds);
    const plannedSections: PreparedDocSection[] = [];
    const createdSections: PreparedDocSection[] = [];
    const scopedEntities = Object.values(index.code.entities)
      .filter((entity) => isSourceCodeEntity(entity) && isEntityInPrepareScope(entity, scope))
      .sort((left, right) => left.path.localeCompare(right.path) || left.range.startOffset - right.range.startOffset);
    const skippedSections = scopedEntities
      .filter((entity) => documentedEntities.has(entity.id))
      .map((entity) => skippedPreparedDocSection(index, entity));
    const missingEntities = scopedEntities.filter(
      (entity) => !documentedEntities.has(entity.id) && shouldCreatePage(entity)
    );

    for (const entity of missingEntities) {
      plannedSections.push({
        entityId: entity.id,
        sectionId: entity.id,
        docPath: this.defaultDocPathForSource(entity.path),
      });
    }

    if (scope.dryRun) {
      return preparedDocsResult(index, scope, scopedEntities, skippedSections, plannedSections, createdSections, true);
    }

    const codeIndexForWrite = hasPrepareScope(scope) ? await buildCodeIndex(this.config) : index.code;
    const groups = groupBy(missingEntities, (entity) => entity.path);

    for (const [sourcePath, entities] of groups) {
      const docPath = this.defaultDocPathForSource(sourcePath);
      const existing = await this.docStateStorage.loadDocState(docPath);
      const state = existing ?? emptyDocState(docPath);
      const layout = planFileLayout(entities);
      for (const planned of layout) {
        const entityForLayout = codeIndexForWrite.entities[planned.entity.id] ?? planned.entity;
        const fresh = docStateSectionForPlannedEntity(planned, entityForLayout, codeIndexForWrite.entities);
        const previous = state.sections[planned.entity.id];
        state.sections[planned.entity.id] = previous ? withPreservedBlockBodies(previous, fresh) : fresh;
        if (!state.sectionOrder.includes(planned.entity.id)) {
          // The module section leads its doc even when added to an existing state.
          if (planned.entity.type === "file") {
            state.sectionOrder.unshift(planned.entity.id);
          } else {
            state.sectionOrder.push(planned.entity.id);
          }
        }
        createdSections.push({ entityId: planned.entity.id, sectionId: planned.entity.id, docPath });
      }
      state.generatedAt = new Date().toISOString();
      await this.docStateStorage.saveDocState(state);
    }

    const rebuiltIndex = await this.rebuildIndexes({ renderDocs: false });
    return preparedDocsResult(
      rebuiltIndex,
      scope,
      scopedEntities,
      skippedSections,
      plannedSections,
      createdSections,
      false
    );
  }

  /**
   * Create or refresh the second/third documentation tiers — one skeleton doc per
   * domain (from the map) plus the project overview — from the injected
   * domain/project entities. Blocks are left empty (a later LLM pass fills them);
   * the composition (members + one-line leads) and relations render immediately.
   * Written prose in an existing tier doc survives. Returns the doc paths that now
   * have a skeleton. No-op when no domain map exists yet.
   */
  async prepareDomainDocs(): Promise<{ docPaths: string[] }> {
    const index = await this.rebuildIndexes({ renderDocs: false });
    const skeletons = buildDomainSkeletons(index.code.entities);
    await this.deleteOrphanTierDocs(new Set(skeletons.keys()));
    const docPaths: string[] = [];
    for (const [docPath, skeleton] of skeletons) {
      const existing = await this.docStateStorage.loadDocState(docPath);
      if (existing) {
        for (const sectionId of skeleton.sectionOrder) {
          const previous = existing.sections[sectionId];
          if (previous) {
            const fresh = withPreservedBlockBodies(previous, skeleton.sections[sectionId]);
            // A rebuilt skeleton starts with no memberDocsFingerprint; carry the
            // previous stamp forward so staleDomainSlugs only flags tiers whose
            // member evidence actually changed, not every tier on every rebuild.
            if (previous.memberDocsFingerprint !== undefined) {
              fresh.memberDocsFingerprint = previous.memberDocsFingerprint;
            }
          }
        }
      }
      await this.docStateStorage.saveDocState(skeleton);
      docPaths.push(docPath);
    }
    await this.rebuildIndexes({ renderDocs: false });
    await this.reconcileRenderedDocs();
    return { docPaths: docPaths.sort() };
  }

  /**
   * Delete tier docs (under `docs/domains/` or the project overview) whose slug is
   * no longer in the current map. A regenerated partition renames or drops domains;
   * their stale docs and state must not linger. Only tier docs are considered — a
   * source doc's path never matches this shape.
   */
  private async deleteOrphanTierDocs(current: Set<string>): Promise<void> {
    const overview = projectDocPath();
    for (const docPath of await this.docStateStorage.listDocStates()) {
      const isTierDoc = docPath === overview || docPath.startsWith("docs/domains/");
      if (isTierDoc && !current.has(docPath)) {
        await this.docStateStorage.deleteDoc(docPath);
      }
    }
  }

  /**
   * Partition the documented files into named domains with one LLM call and save
   * the map. Input is one purpose one-liner per documented file plus the file
   * dependency edges — never source code. Deterministic validation (every file
   * assigned exactly once, ascii-kebab slugs) gates the result, with one
   * retry-with-feedback on a violation. Throws if the input exceeds the model's
   * prompt budget (batched partition is not yet implemented).
   */
  async partitionDomainMap(runtime: GenerateDocsRuntime): Promise<{ domains: number; files: number }> {
    const index = await this.rebuildIndexes({ renderDocs: false });
    const files = await this.collectDocumentedFileLeads(index);
    if (files.length === 0) {
      throw new CodeloreError("NO_DOCUMENTED_FILES", "No documented files to partition into domains.", {});
    }
    const knownFiles = new Set(files.map((file) => file.path));
    const fileDag = buildFileDag(index.code);
    const edges: Array<[string, string]> = [];
    for (const [from, deps] of fileDag) {
      if (!knownFiles.has(from)) {
        continue;
      }
      for (const to of deps) {
        if (knownFiles.has(to)) {
          edges.push([from, to]);
        }
      }
    }

    const providerName = runtime.providerName ?? this.config.llm.partitionProvider;
    const provider = createConfiguredProvider(this.config, providerName, { env: runtime.env, fetch: runtime.fetch });
    const request = buildPartitionRequest({
      files,
      edges,
      language: this.config.docs.language ?? "en",
      writingRules: this.config.docs.writingRules,
    });
    assertRequestFitsBudget(request, provider);

    const completion = await provider.complete(request);
    try {
      const map = parsePartitionResponse(completion.content, knownFiles);
      await this.storage.saveDomainMap(map);
      return { domains: map.domains.length, files: knownFiles.size };
    } catch (error) {
      if (!(error instanceof CodeloreError) || error.code !== "INVALID_LLM_RESPONSE") {
        throw error;
      }
      // One retry with the violation as feedback; a second failure propagates.
      const retryRequest = appendPartitionRetry(request, completion.content, error);
      const retryCompletion = await provider.complete(retryRequest);
      const map = parsePartitionResponse(retryCompletion.content, knownFiles);
      await this.storage.saveDomainMap(map);
      return { domains: map.domains.length, files: knownFiles.size };
    }
  }

  /**
   * Generate the prose of every tier doc (each domain, then the project overview)
   * from the finished member docs. Runs after file docs exist: a domain summarizes
   * its member files' docs, the project summarizes the domain docs. Domains are
   * ordered leaves-first (a domain sees its dependency domains' finished prose), the
   * project last. Each tier doc is written then fact-checked against its member docs;
   * contradicted blocks are dropped. Skeletons are (re)built first so membership is
   * current. Returns the tier doc paths written and how many blocks were dropped.
   */
  async generateDomainDocs(
    runtime: GenerateDocsRuntime,
    options: { slugs?: ReadonlySet<string> } = {}
  ): Promise<{ generated: string[]; droppedBlocks: number; failed: Array<{ slug: string; error: string }> }> {
    await this.prepareDomainDocs();
    const index = await this.rebuildIndexes({ renderDocs: false });
    const map = await this.storage.loadDomainMap();
    if (!map) {
      throw new CodeloreError("NO_DOMAIN_MAP", "No domain map found; run partition first.", {});
    }
    const waves = this.tierGenerationWaves(index, map, options.slugs);
    if (waves.length === 0) {
      return { generated: [], droppedBlocks: 0, failed: [] };
    }

    const { provider, verifyProvider } = this.createProviderPair(runtime);
    const fileMembers = this.buildFileMemberLookup(index);
    const rationaleBySlug = new Map(map.domains.map((domain) => [domain.slug, domain.rationale]));
    const limit = pLimit(this.config.llm.concurrency);

    const generated: string[] = [];
    const generatedEntityIds = new Set<string>();
    const failed: Array<{ slug: string; error: string }> = [];
    let droppedBlocks = 0;
    // Waves are ordered leaves-first; within a wave the domains are independent, so
    // their writer/verify calls run concurrently, but a wave is fully persisted
    // before the next so a dependent reads its dependency domains' finished prose.
    // A single domain that keeps returning invalid output is recorded and skipped —
    // it must not abort the other tiers (its skeleton stays, retryable next run).
    for (const wave of waves) {
      const results = await Promise.all(
        wave.map((entity) =>
          limit(async () => {
            try {
              const members = await this.gatherTierMembers(entity, index, fileMembers);
              const input: BuildDomainWriteRequestInput = {
                tier: {
                  id: entity.id,
                  name: entity.name,
                  kind: entity.type === "project" ? "project" : "domain",
                  ...(rationaleBySlug.get(entity.path) ? { rationale: rationaleBySlug.get(entity.path) } : {}),
                },
                targetBlocks: entity.metadata?.allowedBlocks ?? [],
                existingBlocks: await this.existingTierBlocks(tierDocPathForEntity(entity) ?? "", entity.id),
                members,
                dependencies: await this.gatherTierDependencies(entity, index),
                ...(this.config.docs.writingRules ? { writingRules: this.config.docs.writingRules } : {}),
                ...(this.config.docs.language ? { language: this.config.docs.language } : {}),
              };
              const result = await generateDomainDoc({
                input,
                memberEvidence: memberEvidenceText(members),
                provider,
                verifyProvider,
              });
              return { entity, ...result };
            } catch (error) {
              failed.push({ slug: entity.path, error: error instanceof Error ? error.message : String(error) });
              return { entity, blocks: {}, dropped: [] };
            }
          })
        )
      );
      // Persist serially: renderAndPersist maintains a shared render context.
      for (const { entity, blocks, dropped } of results) {
        droppedBlocks += dropped.length;
        const docPath = tierDocPathForEntity(entity);
        if (docPath && Object.keys(blocks).length > 0) {
          await applyRewritesToDoc(
            docPath,
            [{ sectionId: entity.id, blocks, showFiltered: false }],
            this.docStateStorage,
            index.code.entities,
            this.config,
            new Map()
          );
          generated.push(docPath);
          generatedEntityIds.add(entity.id);
        }
      }
    }
    const finalIndex = await this.rebuildIndexes({ renderDocs: false });
    await this.stampMemberFingerprints(finalIndex, generatedEntityIds);
    await this.reconcileRenderedDocs();
    return { generated: generated.sort(), droppedBlocks, failed };
  }

  /**
   * Stamp each tier doc that was actually (re)written this run with the fingerprint
   * of the member docs it now summarizes, so a later member-doc edit diverges the
   * hash and `collectMemberDocStaleBlocks` flags the tier doc for refresh. Limited
   * to `writtenEntityIds` — a tier that was out of scope or whose writer failed
   * keeps its old stamp, so it is correctly re-selected as stale next run instead of
   * being marked fresh with content it never received.
   */
  private async stampMemberFingerprints(index: ProjectIndex, writtenEntityIds: ReadonlySet<string>): Promise<void> {
    for (const entity of Object.values(index.code.entities)) {
      if (!isDomainTierEntity(entity) || !writtenEntityIds.has(entity.id)) {
        continue;
      }
      const docPath = tierDocPathForEntity(entity);
      if (!docPath) {
        continue;
      }
      const state = await this.docStateStorage.loadDocState(docPath);
      const section = state?.sections[entity.id];
      if (!state || !section) {
        continue;
      }
      const fingerprint = domainMemberFingerprint(collectDomainMemberEvidence(entity, index));
      if (section.memberDocsFingerprint !== fingerprint) {
        section.memberDocsFingerprint = fingerprint;
        await this.docStateStorage.saveDocState(state);
      }
    }
  }

  /**
   * Tier entities as dependency waves: domains leaves-first (each wave after its
   * dependencies), project last. When `slugs` is given, only those tiers are
   * regenerated (a scoped refresh reads its dependency domains' existing docs);
   * the project uses the sentinel slug `.`.
   */
  private tierGenerationWaves(index: ProjectIndex, map: DomainMap, slugs?: ReadonlySet<string>): CodeEntity[][] {
    const dag = buildDomainDag(index.code, fileToDomainSlug(map));
    const wanted = (slug: string): boolean => slugs === undefined || slugs.has(slug);
    const waves: CodeEntity[][] = [];
    for (const wave of dependencyWaves(dag, new Set(dag.keys()))) {
      const entities = wave
        .flat()
        .filter(wanted)
        .map((slug) => index.code.entities[domainIdFor(slug)])
        .filter((entity): entity is CodeEntity => entity !== undefined);
      if (entities.length > 0) {
        waves.push(entities);
      }
    }
    const project = index.code.entities[PROJECT_ID];
    if (project && wanted(project.path)) {
      waves.push([project]);
    }
    return waves;
  }

  /**
   * Source-file path → its documented sections' headings and purpose/responsibility
   * prose. Keyed by the source path derived from each section's owned entity ids, so
   * a file's per-symbol sections group under it regardless of the doc's own path.
   */
  private buildFileMemberLookup(index: ProjectIndex): Map<string, DomainWriteMember> {
    const byPath = new Map<string, DomainWriteMember["sections"]>();
    for (const section of Object.values(index.docs.sections)) {
      const ownerPath = section.owns.map(sourceFilePathOf).find((path): path is string => path !== undefined);
      if (!ownerPath) {
        continue; // a domain/project tier section, not a source file
      }
      const sections = byPath.get(ownerPath) ?? [];
      sections.push({
        heading: section.heading,
        purpose: section.blocks.find((block) => block.id === "purpose")?.body,
        responsibility: section.blocks.find((block) => block.id === "responsibility")?.body,
      });
      byPath.set(ownerPath, sections);
    }
    return new Map([...byPath].map(([path, sections]) => [path, { label: path, sections }]));
  }

  /** Members of a tier doc: a domain's member files, or (for the project) its domains. */
  private async gatherTierMembers(
    entity: CodeEntity,
    index: ProjectIndex,
    fileMembers: Map<string, DomainWriteMember>
  ): Promise<DomainWriteMember[]> {
    if (entity.type === "project") {
      const members: DomainWriteMember[] = [];
      for (const depId of entity.directDeps) {
        if (depId.startsWith(DOMAIN_ID_PREFIX)) {
          const summary = await this.domainDocSummary(depId, index);
          if (summary) {
            members.push(summary);
          }
        }
      }
      return members;
    }
    const members: DomainWriteMember[] = [];
    for (const depId of entity.directDeps) {
      const filePath = sourceFilePathOf(depId);
      const member = filePath ? fileMembers.get(filePath) : undefined;
      if (member) {
        members.push(member);
      }
    }
    return members;
  }

  /** Dependency subsystems of a domain (the domain: ids it depends on); empty for the project. */
  private async gatherTierDependencies(entity: CodeEntity, index: ProjectIndex): Promise<DomainWriteDependency[]> {
    if (entity.type === "project") {
      return [];
    }
    const deps: DomainWriteDependency[] = [];
    for (const depId of entity.directDeps) {
      if (depId.startsWith(DOMAIN_ID_PREFIX)) {
        const summary = await this.domainDocSummary(depId, index);
        if (summary) {
          const name = index.code.entities[depId]?.name ?? summary.label;
          deps.push({ name, ...(summary.sections[0]?.purpose ? { purpose: summary.sections[0].purpose } : {}) });
        }
      }
    }
    return deps;
  }

  /** A domain doc as a member/dependency summary, read fresh from state (leaves written earlier this run). */
  private async domainDocSummary(domainId: string, index: ProjectIndex): Promise<DomainWriteMember | undefined> {
    const slug = domainId.slice(DOMAIN_ID_PREFIX.length);
    const state = await this.docStateStorage.loadDocState(domainDocPath(slug));
    const section = state?.sections[domainId];
    const name = index.code.entities[domainId]?.name ?? slug;
    if (!section) {
      return { label: name, sections: [] };
    }
    return {
      label: name,
      sections: [
        {
          heading: name,
          purpose: section.blocks.purpose?.body,
          responsibility: section.blocks.responsibility?.body,
        },
      ],
    };
  }

  /** Non-empty prose blocks already on a tier doc, so a refresh rewrites rather than starts blank. */
  private async existingTierBlocks(
    docPath: string,
    sectionId: string
  ): Promise<Array<{ blockId: BlockId; body: string; staleReason?: string }>> {
    const state = await this.docStateStorage.loadDocState(docPath);
    const section = state?.sections[sectionId];
    if (!section) {
      return [];
    }
    const existing: Array<{ blockId: BlockId; body: string; staleReason?: string }> = [];
    for (const [blockId, block] of Object.entries(section.blocks)) {
      if (block?.body.trim()) {
        existing.push({
          blockId: blockId as BlockId,
          body: block.body,
          ...(block.staleReason ? { staleReason: block.staleReason } : {}),
        });
      }
    }
    return existing;
  }

  /** One (file, purpose-lead) per documented source file, first doc wins. Tier docs are skipped. */
  private async collectDocumentedFileLeads(index: ProjectIndex): Promise<Array<{ path: string; lead: string }>> {
    const leadByFile = new Map<string, string>();
    for (const docPath of await this.docStateStorage.listDocStates()) {
      const state = await this.docStateStorage.loadDocState(docPath);
      if (!state) {
        continue;
      }
      const lead = docResponsibilities(state);
      if (!lead) {
        continue;
      }
      for (const sectionId of state.sectionOrder) {
        for (const ownedId of state.sections[sectionId]?.owns ?? []) {
          const filePath = sourceFilePathOf(ownedId);
          if (filePath && index.code.fileToEntities[filePath] && !leadByFile.has(filePath)) {
            leadByFile.set(filePath, lead);
          }
        }
      }
    }
    return [...leadByFile.entries()]
      .map(([path, lead]) => ({ path, lead }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async getSectionContext(
    sectionId: string,
    reason?: string,
    options: { includeProjectContext?: boolean; targets?: BlockId[] } = {}
  ): Promise<SectionContext> {
    const { index, section } = await this.resolveSection(sectionId);

    const owns = section.owns.map((entityId) => index.code.entities[entityId]).filter(Boolean);
    const depends = section.depends.map((entityId) => index.code.entities[entityId]).filter(Boolean);
    const directUsages = uniqueEntities(
      owns.flatMap((entity) => entity.directUsages.map((usageId) => index.code.entities[usageId]).filter(Boolean))
    );
    const neighborSections = (index.docs.fileToSections[section.docPath] ?? [])
      .filter((id) => id !== section.id)
      .map((id) => index.docs.sections[id])
      .filter(Boolean)
      .map((item) => ({ id: item.id, heading: item.heading, status: item.status }));
    const includeProjectContext = options.includeProjectContext ?? true;
    const projectContext = includeProjectContext ? await this.getProjectContext() : undefined;
    const { allowedBlocks, skippedBlocks } = collectAllowedBlocksForSection(section, index.code.entities);
    const targets = resolveTargets(options.targets, allowedBlocks, sectionId);

    return {
      section: summarizeDocSection(section),
      targets,
      rewriteInstructions: buildRewriteInstructions(targets, allowedBlocks, skippedBlocks),
      owns: owns.map(summarizeCodeEntity),
      depends: depends.map(summarizeCodeEntity),
      directUsages: directUsages.map(summarizeCodeEntity),
      neighborSections,
      allowedBlocks,
      skippedBlocks,
      reason,
      projectContext,
    };
  }

  async getProjectContext(): Promise<ProjectContext | undefined> {
    if (this.projectContextCache) {
      return this.projectContextCache.value;
    }
    const value = await this.readProjectContext();
    this.projectContextCache = { value };
    return value;
  }

  async rewriteSection(
    sectionId: string,
    input: Omit<RewriteSectionInput, "sectionId">
  ): Promise<{ sectionId: string; docPath: string; filteredBlocks?: FilteredGeneratedBlock[] }> {
    const result = await this.rewriteSections([{ sectionId, ...input }]);
    return result.updatedSections[0];
  }

  async rewriteSections(sections: RewriteSectionInput[]): Promise<{
    updatedSections: Array<{ sectionId: string; docPath: string; filteredBlocks?: FilteredGeneratedBlock[] }>;
  }> {
    if (sections.length === 0) {
      return { updatedSections: [] };
    }

    const duplicateSectionId = firstDuplicate(sections.map((section) => section.sectionId));
    if (duplicateSectionId) {
      throw new CodeloreError("DUPLICATE_SECTION", `Section "${duplicateSectionId}" is listed more than once`, {
        sectionId: duplicateSectionId,
      });
    }

    const index = await this.loadOrRebuildIndexes();
    const normalized = sections.map((section) => normalizeGeneratedRewrite(section, this.config));
    const { byDoc, docPathBySection } = groupRewritesByDoc(normalized, index.docs.sections);

    const filteredBySection = new Map<string, FilteredGeneratedBlock[]>();
    for (const [docPath, rewrites] of byDoc) {
      await applyRewritesToDoc(
        docPath,
        rewrites,
        this.docStateStorage,
        index.code.entities,
        this.config,
        filteredBySection
      );
    }

    await this.patchDocIndexForDocs([...byDoc.keys()]);
    return {
      updatedSections: normalized.map((section) => {
        const filtered = filteredBySection.get(section.sectionId);
        return {
          sectionId: section.sectionId,
          docPath: docPathBySection.get(section.sectionId) ?? "",
          ...(filtered && filtered.length > 0 ? { filteredBlocks: filtered } : {}),
        };
      }),
    };
  }

  async markReviewNeeded(sectionId: string, reason: string): Promise<{ sectionId: string; reason: string }> {
    const { section } = await this.resolveSection(sectionId);
    const { state, sectionState } = await this.requireSectionState(section.docPath, sectionId);
    sectionState.status = "review_needed";
    state.generatedAt = new Date().toISOString();
    await this.docStateStorage.renderAndPersist(state);
    await this.patchDocIndexForDocs([section.docPath]);
    return { sectionId, reason };
  }

  async validateDocs(input: { includeQuality?: boolean } = {}): Promise<{ issues: DocValidationIssue[] }> {
    const index = await this.rebuildIndexes();
    const issues: DocValidationIssue[] = [];

    for (const section of Object.values(index.docs.sections)) {
      issues.push(...validateOwnedEntities(section, index.code.entities));
      issues.push(...validateDependencies(section, index.code.entities, index.docs.sections));
      issues.push(...detectStaleBlocks(section, index.code.entities));
      if (input.includeQuality) {
        issues.push(...validateBlockQuality(section));
      }
    }
    issues.push(...(await this.detectMissingTranslations(index.docs.sections)));
    issues.push(...(await this.detectUncoveredFiles(index)));

    return { issues };
  }

  /**
   * Flags documented files that no domain covers — a new file that fell outside the
   * map. `refreshDomainDocs` assigns them automatically; this makes the drift visible
   * to `check` in the meantime (and when there is no domain map, it stays silent).
   */
  private async detectUncoveredFiles(index: ProjectIndex): Promise<DocValidationIssue[]> {
    const map = await this.storage.loadDomainMap();
    if (!map) {
      return [];
    }
    const documented = (await this.collectDocumentedFileLeads(index)).map((file) => file.path);
    return domainCoverage(map, documented).uncovered.map((file) => ({
      code: "uncovered_file" as const,
      severity: "warning" as const,
      sectionId: "",
      docPath: file,
      message: `${file} is documented but belongs to no domain; run update to assign it.`,
    }));
  }

  /**
   * Flags rendered canonical blocks whose configured translation is missing or
   * stale against the current canonical body — the `.md` shows a "translation
   * pending" callout there. Translations live only in JSON state, so this reads
   * state directly rather than the projected doc index.
   */
  private async detectMissingTranslations(sections: Record<string, DocSection>): Promise<DocValidationIssue[]> {
    const languages = this.config.docs.translations;
    if (languages.length === 0) {
      return [];
    }
    const issues: DocValidationIssue[] = [];
    const docPaths = [...new Set(Object.values(sections).map((section) => section.docPath))];
    for (const docPath of docPaths) {
      const state = await this.docStateStorage.loadDocState(docPath);
      if (!state) {
        continue;
      }
      for (const { sectionId, blockId, block } of translatableBlocks(state)) {
        for (const language of languages) {
          if (isTranslationCurrent(block, language)) {
            continue;
          }
          issues.push({
            code: "missing_translation",
            severity: "warning",
            sectionId,
            docPath,
            blockId,
            message: `Block "${this.config.docs.blockHeadings[blockId]}" has no current "${language}" translation; run update to refresh.`,
          });
        }
      }
    }
    return issues;
  }

  async refreshStaleDocs(input: RefreshStaleDocsInput = {}): Promise<RefreshStaleDocsResult> {
    const mode = input.mode ?? "report";
    const index = await this.rebuildIndexes();
    const scoped = filterSectionsByScope(Object.values(index.docs.sections), input.scope, index.code.entities);
    const stale = mergeStaleBlocks(
      collectStaleBlocks(scoped, index.code.entities),
      collectDepDocStaleBlocks(scoped, index),
      collectMemberDocStaleBlocks(scoped, index),
      collectLanguageStaleBlocks(scoped, this.config.docs.language)
    );
    const tombstoned = collectTombstonedBlocks(scoped, index.code.entities);

    if (mode === "report") {
      return refreshStaleResult(mode, stale, tombstoned);
    }
    if (mode === "rewrite_plan") {
      const rewritePlan = [...stale, ...tombstoned].map((entry) => buildRewriteContextBundle(entry, index));
      return refreshStaleResult(mode, stale, tombstoned, [], rewritePlan);
    }

    const appliedTombstones = await this.applyTombstones(stale);
    if (appliedTombstones.length === 0) {
      return refreshStaleResult(mode, stale, tombstoned, appliedTombstones);
    }
    await this.patchDocIndexForDocs([...new Set(appliedTombstones.map((entry) => entry.docPath))]);
    const refreshed = await this.loadOrRebuildIndexes();
    const refreshedScoped = filterSectionsByScope(
      Object.values(refreshed.docs.sections),
      input.scope,
      refreshed.code.entities
    );
    const refreshedTombstoned = collectTombstonedBlocks(refreshedScoped, refreshed.code.entities);
    return refreshStaleResult(mode, stale, refreshedTombstoned, appliedTombstones);
  }

  async generateDocsForEntity(
    input: GenerateDocsForEntityInput,
    runtime: GenerateDocsRuntime
  ): Promise<GenerateDocsResult> {
    const sectionIds = await this.resolveSectionsForId(input.id);
    const result = await this.runPipelineForSections(sectionIds, input.intent, runtime);
    await this.translateScope(scopeFromParts(sectionIds, [], []), runtime);
    return result;
  }

  async generateDocsForScope(
    input: GenerateDocsForScopeInput,
    runtime: GenerateDocsRuntime
  ): Promise<GenerateDocsResult> {
    const hasScope = (input.paths?.length ?? 0) + (input.files?.length ?? 0) + (input.entityIds?.length ?? 0) > 0;
    const prepared = await this.prepareInitialDocs({
      paths: input.paths,
      files: input.files,
      entityIds: input.entityIds,
      dryRun: false,
    });

    const sectionIds = new Set(prepared.createdSections.map((entry) => entry.sectionId));
    const targetBlocksBySection = new Map<string, BlockId[]>();

    const scopeSectionIds = [
      ...prepared.skippedSections.flatMap((entry) => entry.sectionIds),
      ...prepared.createdSections.map((entry) => entry.sectionId),
    ];
    // An empty scoped list must mean "nothing to refresh": filterSectionsByScope
    // treats an empty scope as no filter and would tombstone the whole repo.
    const scope = hasScope ? scopeFromParts(scopeSectionIds, input.files ?? [], input.paths ?? []) : undefined;
    if (!hasScope || scope) {
      await this.reconcileScopedDocStates(scope);
      if (input.force) {
        // No tombstone targeting: adding a section without a target-block entry makes
        // the pipeline regenerate all its allowed blocks (resolveTargets defaults to
        // the full allowed set), so a fresh-but-review_needed section gets a real
        // regeneration and clears via the write path.
        for (const sectionId of scopeSectionIds) {
          sectionIds.add(sectionId);
        }
      } else {
        const refreshed = await this.refreshStaleDocs({ mode: "tombstone", scope });
        for (const entry of refreshed.tombstoned) {
          sectionIds.add(entry.sectionId);
          addTargetBlock(targetBlocksBySection, entry.sectionId, entry.blockId);
        }
      }
    }

    // Tier docs are generated by generateDomainDocs, never the file pipeline; keep
    // any that drifted into scope out of runPipelineForSections.
    const { sourceIds } = splitTierSections([...sectionIds]);
    const result = await this.runPipelineForSections(sourceIds, input.intent, runtime, targetBlocksBySection);
    // Translate the whole requested scope, not just regenerated docs: adding a
    // language must back-fill already-fresh docs in scope, not only changed ones.
    await this.translateScope(scope, runtime);
    await this.reconcileRenderedDocs();
    // A whole-project document also builds/refreshes the domain tier: the map is
    // drawn once (if missing), then only domains whose member docs changed are
    // regenerated. A scoped document leaves the tier to the update/stale cascade.
    if (!hasScope) {
      await this.refreshDomainDocs(runtime);
    }
    return result;
  }

  /**
   * Refresh the domain tier automatically: regenerate only the tier docs whose
   * members changed (or were never written). No full re-render on every edit — a
   * domain is touched only when the purpose/responsibility of one of its members
   * actually changed. Drawing the map is a separate, deliberate step
   * (`partitionDomainMap`); with no map this is a no-op, so a project that never
   * opted into domains is left untouched.
   */
  async refreshDomainDocs(
    runtime: GenerateDocsRuntime
  ): Promise<{ generated: string[]; droppedBlocks: number; failed: Array<{ slug: string; error: string }> }> {
    const empty = { generated: [], droppedBlocks: 0, failed: [] };
    if (!(await this.storage.loadDomainMap())) {
      return empty;
    }
    await this.assignUncoveredFiles(runtime);
    await this.prepareDomainDocs();
    const slugs = this.staleDomainSlugs(await this.rebuildIndexes({ renderDocs: false }));
    if (slugs.size === 0) {
      return empty;
    }
    return this.generateDomainDocs(runtime, { slugs });
  }

  /**
   * Place documented files that no domain covers into an existing domain with one
   * light LLM call (all uncovered files batched into a single request), then save
   * the map. Membership change makes the receiving domains stale, so the caller's
   * refresh regenerates them. A new domain is never created here — that is a
   * deliberate full re-partition. No-op when nothing is uncovered. Runs on the
   * cheap verify provider: picking one domain from a fixed list is classification,
   * not the boundary-drawing that partition needs the strong model for.
   */
  private async assignUncoveredFiles(runtime: GenerateDocsRuntime): Promise<void> {
    const map = await this.storage.loadDomainMap();
    if (!map) {
      return;
    }
    const index = await this.rebuildIndexes({ renderDocs: false });
    const leads = await this.collectDocumentedFileLeads(index);
    const uncovered = domainCoverage(
      map,
      leads.map((file) => file.path)
    ).uncovered;
    if (uncovered.length === 0) {
      return;
    }
    const leadByPath = new Map(leads.map((file) => [file.path, file.lead]));
    const request = buildAssignRequest({
      files: uncovered.map((path) => ({ path, lead: leadByPath.get(path) ?? "" })),
      domains: map.domains.map((domain) => ({
        slug: domain.slug,
        name: domain.name,
        ...(domain.rationale ? { rationale: domain.rationale } : {}),
      })),
      language: this.config.docs.language ?? "en",
    });
    const { verifyProvider } = this.createProviderPair(runtime);
    const knownSlugs = new Set(map.domains.map((domain) => domain.slug));
    const knownFiles = new Set(uncovered);
    const completion = await verifyProvider.complete(request);
    let assignments: Map<string, string>;
    try {
      assignments = parseAssignResponse(completion.content, knownFiles, knownSlugs);
    } catch (error) {
      if (!(error instanceof CodeloreError) || error.code !== "INVALID_LLM_RESPONSE") {
        throw error;
      }
      // One retry with the violation as feedback; a second failure propagates.
      const retryRequest = {
        ...request,
        messages: [
          ...request.messages,
          { role: "assistant" as const, content: completion.content },
          {
            role: "user" as const,
            content: `Your previous response was invalid: ${error.message}. Return ONLY the corrected JSON object, same shape.`,
          },
        ],
      };
      const retryCompletion = await verifyProvider.complete(retryRequest);
      assignments = parseAssignResponse(retryCompletion.content, knownFiles, knownSlugs);
    }

    const bySlug = new Map(map.domains.map((domain) => [domain.slug, domain]));
    for (const [file, slug] of assignments) {
      const domain = bySlug.get(slug);
      if (domain && !domain.files.includes(file)) {
        domain.files = [...domain.files, file].sort();
      }
    }
    map.generatedAt = new Date().toISOString();
    await this.storage.saveDomainMap(map);
  }

  /** Tier slugs needing regeneration: never written (empty purpose) or member docs diverged from the stamp. */
  private staleDomainSlugs(index: ProjectIndex): Set<string> {
    const slugs = new Set<string>();
    for (const section of Object.values(index.docs.sections)) {
      const slug = section.id.startsWith(DOMAIN_ID_PREFIX)
        ? section.id.slice(DOMAIN_ID_PREFIX.length)
        : section.id === PROJECT_ID
          ? "."
          : undefined;
      if (slug === undefined) {
        continue;
      }
      const purposeFilled = section.blocks.some((block) => block.id === "purpose" && block.body.trim() !== "");
      const entity = index.code.entities[section.owns[0] ?? ""];
      if (!purposeFilled || !entity) {
        slugs.add(slug);
        continue;
      }
      const current = domainMemberFingerprint(collectDomainMemberEvidence(entity, index));
      if (current !== section.memberDocsFingerprint) {
        slugs.add(slug);
      }
    }
    return slugs;
  }

  async fixStaleDocs(input: FixStaleDocsInput, runtime: GenerateDocsRuntime): Promise<GenerateDocsResult> {
    const scope = scopeFromParts(input.sectionIds ?? [], input.files ?? [], input.paths ?? []);
    await this.gateDepDocsCascade(scope, runtime);
    const refreshed = await this.refreshStaleDocs({ mode: "tombstone", scope });
    const targetBlocksBySection = targetBlocksFromTombstones(refreshed.tombstoned);
    // Tier docs (domain/project) regenerate through the domain pipeline, not the
    // file pipeline; split them out so a stale summary doc is refreshed correctly.
    const { sourceIds, tierSlugs } = splitTierSections([...targetBlocksBySection.keys()]);
    const result = await this.runPipelineForSections(sourceIds, input.intent, runtime, targetBlocksBySection);
    await this.translateScope(scope, runtime);
    if (tierSlugs.size > 0) {
      await this.generateDomainDocs(runtime, { slugs: tierSlugs });
    }
    await this.reconcileRenderedDocs();
    return result;
  }

  /**
   * Cross-doc links converge only after every doc touched by a run is on disk:
   * a doc rendered early in the run cannot link to a dependent's doc created
   * later. Re-render all docs whose rendered markdown drifted from state.
   */
  private async reconcileRenderedDocs(): Promise<void> {
    const { updated } = await this.docStateStorage.reconcileRenderedDocs();
    if (updated.length > 0) {
      await this.patchDocIndexForDocs(updated);
    }
  }

  /**
   * Verify-gate for the depDocs cascade. A section flagged stale *only* because a
   * dependency's docs changed (its own code is untouched) may still be correct — a
   * cosmetic rephrase of the dependency does not invalidate it. Before tombstoning
   * such sections, fact-check their existing text against the new dependency docs;
   * sections with no contradiction get their fingerprint refreshed (so the
   * subsequent tombstone pass skips them) instead of a full regeneration. Sections
   * with a contradiction are left stale and refilled normally.
   */
  private async gateDepDocsCascade(scope: RefreshStaleDocsInput["scope"], runtime: GenerateDocsRuntime): Promise<void> {
    const report = await this.refreshStaleDocs({ mode: "report", scope });
    const depDocsOnly = report.stale.filter(
      (entry) => entry.changedFacets.length === 1 && entry.changedFacets[0] === "depDocs"
    );
    if (depDocsOnly.length === 0) {
      return;
    }

    const blocksBySection = new Map<string, BlockId[]>();
    for (const entry of depDocsOnly) {
      const bucket = blocksBySection.get(entry.sectionId) ?? [];
      bucket.push(entry.blockId as BlockId);
      blocksBySection.set(entry.sectionId, bucket);
    }

    const index = await this.loadOrRebuildIndexes();
    // Pure fact-check against dependency docs — run it on the verify provider.
    const { verifyProvider } = this.createProviderPair(runtime);
    const targets = [...blocksBySection].map(([sectionId, blockIds]) => ({ sectionId, blockIds }));
    const verifiedClean = await verifyBlocksAgainstDeps({ service: this, index, targets, provider: verifyProvider });

    // Only sections the verifier actually confirmed consistent are refreshed; sections
    // it could not verify stay flagged and fall through to normal regeneration.
    const cleared = targets
      .filter((target) => verifiedClean.has(target.sectionId))
      .map((target) => ({ sectionId: target.sectionId, docPath: index.docs.sections[target.sectionId]?.docPath ?? "" }))
      .filter((entry) => entry.docPath !== "");
    if (cleared.length > 0) {
      await this.recordDepDocsFingerprints(cleared);
    }
  }

  async appendGenerationHistory(docPath: string, sectionId: string, entry: GenerationHistoryEntry): Promise<void> {
    const state = await this.docStateStorage.loadDocState(docPath);
    if (!state) {
      return;
    }
    const sectionState = state.sections[sectionId];
    if (!sectionState) {
      return;
    }
    sectionState.generationHistory = [...(sectionState.generationHistory ?? []), entry];
    state.generatedAt = new Date().toISOString();
    await this.docStateStorage.renderAndPersist(state);
  }

  /**
   * Writer provider plus the fact-check provider. They differ only when
   * `llm.verifyProvider` is configured and the run did not force a single
   * provider via `--provider` — an explicit override means "use this model for
   * everything", so it wins over the split.
   */
  private createProviderPair(runtime: { providerName?: string; env: NodeJS.ProcessEnv; fetch?: typeof fetch }): {
    provider: ChatCompletionProvider;
    verifyProvider: ChatCompletionProvider;
  } {
    const providerRuntime = { env: runtime.env, fetch: runtime.fetch };
    const provider = createConfiguredProvider(this.config, runtime.providerName, providerRuntime);
    const verifyName = this.config.llm.verifyProvider;
    const verifyProvider =
      verifyName && !runtime.providerName
        ? createConfiguredProvider(this.config, verifyName, providerRuntime)
        : provider;
    return { provider, verifyProvider };
  }

  private async runPipelineForSections(
    sectionIds: string[],
    intent: string | undefined,
    runtime: GenerateDocsRuntime,
    targetBlocksBySection: ReadonlyMap<string, BlockId[]> = new Map()
  ): Promise<GenerateDocsResult> {
    const { provider, verifyProvider } = this.createProviderPair(runtime);
    const runId = runtime.runId ?? randomUUID();
    const updatedSections: GeneratedSectionSummary[] = [];
    const skipped: Array<{ sectionId: string; reason: string }> = [];
    const failed: Array<{ sectionId: string; stage: "plan" | "apply"; error: string; code?: string }> = [];
    const updatedFiles = new Set<string>();

    const index = await this.loadOrRebuildIndexes();
    const sectionsByFile = new Map<string, string[]>();
    // Refill targets come from tombstones, which can include a block the entity no
    // longer allows (e.g. a method shrank so block-inclusion dropped changeGuide).
    // Intersect requested targets with the current allowed set so a now-disallowed
    // block never reaches resolveTargets (which would throw and abort the whole
    // file group). A section whose targets all vanish has nothing left to refill.
    const effectiveTargets = new Map<string, BlockId[]>();
    for (const sectionId of [...new Set(sectionIds)]) {
      const section = index.docs.sections[sectionId];
      const ownerId = section?.owns[0];
      const path = ownerId ? index.code.entities[ownerId]?.path : undefined;
      if (!section || !path) {
        skipped.push({ sectionId, reason: "Section owner entity is missing from the code index." });
        continue;
      }
      const requested = targetBlocksBySection.get(sectionId);
      if (requested) {
        const allowed = new Set(collectAllowedBlocksForSection(section, index.code.entities).allowedBlocks);
        const filtered = requested.filter((blockId) => allowed.has(blockId));
        if (filtered.length === 0) {
          skipped.push({ sectionId, reason: "No target blocks remain in the entity's allowed set." });
          continue;
        }
        effectiveTargets.set(sectionId, filtered);
      }
      const bucket = sectionsByFile.get(path) ?? [];
      bucket.push(sectionId);
      sectionsByFile.set(path, bucket);
    }

    // Two flat passes, each fully parallel: propagating blocks (purpose/responsibility/
    // invariants) from each file's own code, then terminal blocks that read the
    // now-written propagating docs of their dependencies. No graph-ordered waves —
    // the split removes the dependency-doc cycle, so generation no longer serializes
    // by import depth.
    const files = [...sectionsByFile.keys()];
    const limit = pLimit(this.config.llm.concurrency);

    const runPhase = async (phase: GenerationPhase): Promise<void> => {
      const phaseIndex = await this.loadOrRebuildIndexes();
      const settled = await Promise.allSettled(
        files.map((file) =>
          limit(() =>
            generateFileGroup({
              service: this,
              index: phaseIndex,
              files: [file],
              sectionIds: sectionsByFile.get(file) ?? [],
              intent,
              provider,
              verifyProvider,
              runId,
              command: runtime.command,
              phase,
              targetBlocksBySection: effectiveTargets,
            })
          )
        )
      );

      // Apply is sequential: rewriteSections/markReviewNeeded mutate the shared
      // projectIndexCache via the incremental doc-index patch.
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const groupSectionIds = sectionsByFile.get(files[i]) ?? [];
        if (outcome.status === "rejected") {
          for (const sectionId of groupSectionIds) {
            failed.push({ sectionId, stage: "plan", ...describeError(outcome.reason) });
          }
          continue;
        }
        try {
          await this.applyFileGenerationOutcome(outcome.value, runtime.command, runId, intent, provider, phase, {
            updatedSections,
            skipped,
            updatedFiles,
            groupSectionIds,
          });
        } catch (error) {
          for (const sectionId of groupSectionIds) {
            failed.push({ sectionId, stage: "apply", ...describeError(error) });
          }
        }
      }
    };

    await runPhase("propagating");
    await runPhase("terminal");

    return {
      runId,
      provider: provider.name,
      model: provider.model,
      updatedFiles: [...updatedFiles],
      updatedSections: mergeSectionSummaries(updatedSections),
      skipped: dedupeSkipped(skipped, updatedSections),
      failed,
    };
  }

  private async applyFileGenerationOutcome(
    outcome: FileGenerationOutcome,
    command: string,
    runId: string,
    intent: string | undefined,
    provider: { name: string; model: string },
    phase: GenerationPhase,
    sink: {
      updatedSections: GeneratedSectionSummary[];
      skipped: Array<{ sectionId: string; reason: string }>;
      updatedFiles: Set<string>;
      groupSectionIds: string[];
    }
  ): Promise<void> {
    const writtenIds = new Set(outcome.writtenSections.map((section) => section.sectionId));

    if (outcome.rewrites.length > 0) {
      await this.rewriteSections(outcome.rewrites);
      // Only terminal blocks consume dependency docs, so the section's dependency-doc
      // fingerprint is meaningful only once the terminal phase has (re)generated them.
      // Recording it after the propagating phase would bless un-regenerated terminal
      // text as fresh against dep docs it was never checked on.
      if (phase === "terminal") {
        await this.recordDepDocsFingerprints(outcome.writtenSections);
      }
    }
    for (const review of outcome.reviewSections) {
      await this.markReviewNeeded(review.sectionId, review.reason);
    }
    for (const kept of outcome.keptBlocks) {
      await this.markReviewNeeded(kept.sectionId, `Block "${kept.blockId}": ${kept.reason}`);
    }

    for (const written of outcome.writtenSections) {
      sink.updatedFiles.add(written.docPath);
      const manualReviewNeeded = outcome.keptBlocks.some((kept) => kept.sectionId === written.sectionId);
      sink.updatedSections.push({
        sectionId: written.sectionId,
        docPath: written.docPath,
        generatedBlocks: written.blocks,
        manualReviewNeeded,
        ...(outcome.debugPathByDoc[written.docPath]
          ? { generationDebugPath: outcome.debugPathByDoc[written.docPath] }
          : {}),
      });
      await this.appendGenerationHistory(written.docPath, written.sectionId, {
        runId,
        timestamp: new Date().toISOString(),
        command,
        ...(intent ? { intent } : {}),
        provider: provider.name,
        model: provider.model,
        generatedBlocks: written.blocks,
        ...(manualReviewNeeded ? { manualReviewNeeded: true } : {}),
      });
    }

    for (const sectionId of sink.groupSectionIds) {
      if (!writtenIds.has(sectionId) && !outcome.reviewSections.some((review) => review.sectionId === sectionId)) {
        sink.skipped.push({ sectionId, reason: "No target blocks required generation." });
      }
    }
  }

  /**
   * Stores per section the fingerprint of its file's dependency docs, computed
   * per single file from the post-write index — the same computation
   * collectDepDocStaleBlocks repeats later. A group-level fingerprint would
   * never match the per-file recomputation for files generated in a
   * multi-file SCC group.
   */
  private async recordDepDocsFingerprints(
    writtenSections: Array<{ sectionId: string; docPath: string }>
  ): Promise<void> {
    const index = await this.loadOrRebuildIndexes();
    const fingerprintByFile = new Map<string, string>();
    const byDoc = groupBy(writtenSections, (entry) => entry.docPath);
    for (const [docPath, entries] of byDoc) {
      const state = await this.docStateStorage.loadDocState(docPath);
      if (!state) {
        continue;
      }
      let mutated = false;
      for (const entry of entries) {
        const sectionState = state.sections[entry.sectionId];
        const ownerId = index.docs.sections[entry.sectionId]?.owns[0];
        const file = ownerId ? index.code.entities[ownerId]?.path : undefined;
        if (!sectionState || !file) {
          continue;
        }
        let fingerprint = fingerprintByFile.get(file);
        if (fingerprint === undefined) {
          fingerprint = dependencyDocsFingerprint(collectDependencyDocs(index, [file]));
          fingerprintByFile.set(file, fingerprint);
        }
        sectionState.depDocsFingerprint = fingerprint;
        mutated = true;
      }
      if (mutated) {
        await this.docStateStorage.renderAndPersist(state);
      }
    }
  }

  /**
   * Brings translations up to date for every doc in `scope` — not only the docs
   * regenerated this run. This is what back-fills already-fresh docs when a new
   * language is added: the per-doc pass skips blocks whose translation is current,
   * so re-translating an unchanged scope is cheap and idempotent. No-op when no
   * translation language is configured.
   */
  private async translateScope(scope: RefreshStaleScope | undefined, runtime: GenerateDocsRuntime): Promise<void> {
    if (this.config.docs.translations.length === 0) {
      return;
    }
    const index = await this.loadOrRebuildIndexes();
    const scoped = filterSectionsByScope(Object.values(index.docs.sections), scope, index.code.entities);
    const docPaths = [...new Set(scoped.map((section) => section.docPath))];
    if (docPaths.length === 0) {
      return;
    }
    // A doc's source files drive its module-scoped terms; collect them from the
    // sections' owning entities so the translator gets the same terms the writer used.
    const sourcePathsByDoc = new Map<string, string[]>();
    for (const section of scoped) {
      const ownerPath = index.code.entities[section.owns[0]]?.path;
      if (!ownerPath) {
        continue;
      }
      const bucket = sourcePathsByDoc.get(section.docPath) ?? [];
      if (!bucket.includes(ownerPath)) {
        bucket.push(ownerPath);
      }
      sourcePathsByDoc.set(section.docPath, bucket);
    }
    const provider = createConfiguredProvider(this.config, runtime.providerName, {
      env: runtime.env,
      fetch: runtime.fetch,
    });
    const languages = this.config.docs.translations;
    const limit = pLimit(this.config.llm.concurrency);
    await Promise.all(
      docPaths.map((docPath) =>
        limit(() => this.translateDoc(docPath, languages, provider, sourcePathsByDoc.get(docPath) ?? []))
      )
    );
  }

  private async translateDoc(
    docPath: string,
    languages: string[],
    provider: ChatCompletionProvider,
    sourcePaths: string[]
  ): Promise<void> {
    const state = await this.docStateStorage.loadDocState(docPath);
    if (!state) {
      return;
    }
    const keep = new Set(languages);
    let mutated = pruneTranslations(state, keep);

    for (const language of languages) {
      const pending: TranslateBlockInput[] = [];
      for (const { sectionId, blockId, block } of translatableBlocks(state)) {
        if (isTranslationCurrent(block, language)) {
          continue;
        }
        pending.push({ sectionId, blockId, heading: this.config.docs.blockHeadings[blockId], text: block.body });
      }
      if (pending.length === 0) {
        continue;
      }
      const translated = await translateBlocks(provider, {
        language,
        blocks: pending,
        ...languagePromptOptions(this.config.docs, language, sourcePaths),
      });
      for (const entry of pending) {
        const body = translated.get(translationBlockKey(entry.sectionId, entry.blockId));
        if (body === undefined) {
          continue; // failed validation → keep previous translation / render pending callout
        }
        const block = state.sections[entry.sectionId]?.blocks[entry.blockId];
        if (!block) {
          continue;
        }
        block.translations = {
          ...block.translations,
          [language]: { body, sourceFingerprint: translationSourceFingerprint(block.body) },
        };
        mutated = true;
      }
    }

    if (mutated) {
      await this.docStateStorage.renderAndPersist(state);
    }
  }

  private async resolveSectionsForId(id: string): Promise<string[]> {
    const index = await this.loadOrRebuildIndexes();
    if (index.docs.sections[id]) {
      return [id];
    }
    if (!index.code.entities[id]) {
      throw new CodeloreError(
        "UNKNOWN_ENTITY",
        `Unknown entity or section id "${id}". Use document with paths, files, or entityIds for new documentation.`,
        { id }
      );
    }
    const sectionIds = Object.values(index.docs.sections)
      .filter((section) => section.owns.includes(id))
      .map((section) => section.id);
    if (sectionIds.length === 0) {
      throw new CodeloreError(
        "UNKNOWN_SECTION",
        `Entity "${id}" has no documentation section. Use document with entityIds=["${id}"] to create it.`,
        { entityId: id }
      );
    }
    return sectionIds;
  }

  private async applyTombstones(
    stale: StaleBlockInfo[]
  ): Promise<Array<{ sectionId: string; blockId: string; docPath: string }>> {
    const tombstoned: Array<{ sectionId: string; blockId: string; docPath: string }> = [];
    const byDoc = groupBy(stale, (entry) => entry.docPath);
    const since = new Date().toISOString();

    for (const [docPath, entries] of byDoc) {
      const state = await this.docStateStorage.loadDocState(docPath);
      if (!state) {
        continue;
      }
      let mutated = false;
      for (const entry of entries) {
        const sectionState = state.sections[entry.sectionId];
        const block = sectionState?.blocks[entry.blockId];
        if (!sectionState || !block) {
          continue;
        }
        const reason = staleReasonFor(entry);
        block.staleSince = since;
        block.staleReason = reason;
        block.staleFacets = entry.changedFacets;
        tombstoned.push({ sectionId: entry.sectionId, blockId: entry.blockId, docPath });
        mutated = true;
      }
      if (mutated) {
        updateStatusFromBlocks(state);
        state.generatedAt = since;
        await this.docStateStorage.renderAndPersist(state);
      }
    }

    return tombstoned;
  }

  async readDocSection(sectionId: string): Promise<string> {
    const { section } = await this.resolveSection(sectionId);
    const { sectionState } = await this.requireSectionState(section.docPath, sectionId);
    return renderSection(sectionState, this.config);
  }

  async readCodeEntity(entityId: string): Promise<unknown> {
    const index = await this.loadOrRebuildIndexes();
    const entity = index.code.entities[entityId];
    if (!entity) {
      throw new CodeloreError("UNKNOWN_ENTITY", `Unknown entity id "${entityId}"`, { entityId });
    }
    return { ...entity, code: await this.readEntityCode(entity) };
  }

  async readImpact(entityId: string): Promise<unknown> {
    const index = await this.loadOrRebuildIndexes();
    return getImpactForEntity(index.code, index.docs, entityId);
  }

  async readChange(changeId: string): Promise<ChangeAnalysis> {
    const change = await this.storage.loadChangeAnalysis(changeId);
    if (!change) {
      throw new CodeloreError("UNKNOWN_CHANGE", `Unknown change id "${changeId}"`, { changeId });
    }
    return change;
  }

  async readDocFile(docPath: string): Promise<string> {
    return readFile(join(this.config.rootDir, docPath), "utf8");
  }

  private defaultDocPathForSource(sourcePath: string): string {
    const sourceWithoutExtension = stripSupportedSourceExtension(sourcePath);
    if (!sourceWithoutExtension || hasColocatedDocNameCollision(this.config.rootDir, sourcePath)) {
      return `${sourcePath}.codelore.md`;
    }
    return `${sourceWithoutExtension}.codelore.md`;
  }

  private changedEntitiesFromFiles(index: ProjectIndex, changedFiles: string[]): string[] {
    return uniqueSorted(
      changedFiles
        .flatMap((path) => index.code.fileToEntities[path] ?? [])
        .filter((entityId) => Boolean(index.code.entities[entityId]))
    );
  }

  private assertKnownEntityIds(index: ProjectIndex, entityIds: string[]): void {
    const unknownEntityIds = entityIds.filter((entityId) => !index.code.entities[entityId]);
    if (unknownEntityIds.length > 0) {
      throw new CodeloreError("UNKNOWN_ENTITY", `Unknown entity id "${unknownEntityIds[0]}"`, {
        entityIds: unknownEntityIds,
      });
    }
  }

  private changedEntitiesFromDiff(index: ProjectIndex, diff: string): string[] {
    const changed = new Set<string>();
    for (const file of parseUnifiedDiff(diff)) {
      const entitiesInFile = index.code.fileToEntities[file.path] ?? [];
      for (const entityId of entitiesInFile) {
        const entity = index.code.entities[entityId];
        if (!entity) {
          continue;
        }
        if (
          file.ranges.some((range) =>
            rangesOverlap(range.startLine, range.endLine, entity.range.startLine, entity.range.endLine)
          )
        ) {
          changed.add(entityId);
        }
      }
    }
    return [...changed].sort();
  }

  private async readGitDiff(): Promise<string> {
    try {
      const result = await execFileAsync("git", ["diff", "--unified=0"], { cwd: this.config.rootDir });
      return result.stdout;
    } catch {
      return "";
    }
  }

  private async resolveSection(sectionId: string): Promise<{ index: ProjectIndex; section: DocSection }> {
    const index = await this.loadOrRebuildIndexes();
    const section = index.docs.sections[sectionId];
    if (!section) {
      throw new CodeloreError("UNKNOWN_SECTION", `Unknown section id "${sectionId}"`, { sectionId });
    }
    return { index, section };
  }

  private async requireSectionState(
    docPath: string,
    sectionId: string
  ): Promise<{ state: DocState; sectionState: DocStateSection }> {
    const state = await this.docStateStorage.loadDocState(docPath);
    if (!state) {
      throw new CodeloreError("UNKNOWN_DOC", `No state for ${docPath}`, { docPath });
    }
    const sectionState = state.sections[sectionId];
    if (!sectionState) {
      throw new CodeloreError("UNKNOWN_SECTION", `Section "${sectionId}" missing from state ${docPath}`, {
        sectionId,
        docPath,
      });
    }
    return { state, sectionState };
  }

  private async readEntityCode(entity: CodeEntity): Promise<string> {
    const text = await readFile(join(this.config.rootDir, entity.path), "utf8");
    return text.slice(entity.range.startOffset, entity.range.endOffset);
  }

  private async readProjectContext(): Promise<ProjectContext | undefined> {
    return writingRulesContext(this.config.docs);
  }
}

/** Global voice/style rules as the writer's project context (terms are resolved separately, per file group). */
function writingRulesContext(config: CodeloreConfig["docs"]): ProjectContext | undefined {
  const rules = configuredStrings(config.writingRules);
  if (rules.length === 0) {
    return undefined;
  }
  return { text: rules.map((rule) => `- ${rule}`).join("\n"), sources: ["codelore.config.json:docs.writingRules"] };
}

function configuredStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function languagePromptOptions(
  config: CodeloreConfig["docs"],
  language: string,
  filePaths: readonly string[]
): { writingRules?: string[]; terms?: string[] } {
  const writingRules = configuredStrings(config.writingRules);
  const terms = resolveTerms(config, filePaths, language);
  return {
    ...(writingRules.length > 0 ? { writingRules } : {}),
    ...(terms.length > 0 ? { terms } : {}),
  };
}

function scopeFromParts(sectionIds: string[], files: string[], paths: string[]): RefreshStaleScope | undefined {
  if (sectionIds.length === 0 && files.length === 0 && paths.length === 0) {
    return undefined;
  }
  return {
    ...(sectionIds.length > 0 ? { sectionIds } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
}

function summarizeProjectIndex(index: ProjectIndex, verbose: boolean): RebuildIndexResult {
  return {
    ok: true,
    version: index.version,
    generatedAt: index.generatedAt,
    codeEntities: Object.keys(index.code.entities).length,
    codeFiles: Object.keys(index.code.fileToEntities).length,
    docSections: Object.keys(index.docs.sections).length,
    docFiles: Object.keys(index.docs.fileToSections).length,
    ...(verbose ? { index } : {}),
  };
}

function stripSupportedSourceExtension(sourcePath: string): string | undefined {
  const match = /^(.*)\.(?:ts|js)$/.exec(sourcePath);
  return match?.[1];
}

function hasColocatedDocNameCollision(rootDir: string, sourcePath: string): boolean {
  const match = /^(.*)\.(ts|js)$/.exec(sourcePath);
  if (!match) {
    return false;
  }
  const [, sourceWithoutExtension, extension] = match;
  const siblingExtension = extension === "ts" ? "js" : "ts";
  return existsSync(join(rootDir, `${sourceWithoutExtension}.${siblingExtension}`));
}

/**
 * A section is generated across both passes (propagating, then terminal), so it can
 * appear twice in the summary; collapse to one entry per section with the union of
 * its generated blocks.
 */
function mergeSectionSummaries(summaries: GeneratedSectionSummary[]): GeneratedSectionSummary[] {
  const byId = new Map<string, GeneratedSectionSummary>();
  for (const summary of summaries) {
    const existing = byId.get(summary.sectionId);
    if (!existing) {
      byId.set(summary.sectionId, { ...summary, generatedBlocks: [...summary.generatedBlocks] });
      continue;
    }
    existing.generatedBlocks = [...new Set([...existing.generatedBlocks, ...summary.generatedBlocks])];
    existing.manualReviewNeeded = existing.manualReviewNeeded || summary.manualReviewNeeded;
    if (summary.generationDebugPath) {
      existing.generationDebugPath = summary.generationDebugPath;
    }
  }
  return [...byId.values()];
}

/**
 * A section with no targets in one pass is reported "skipped" by that pass even though
 * the other pass wrote it; keep only sections genuinely written by neither, deduped.
 */
function dedupeSkipped(
  skipped: Array<{ sectionId: string; reason: string }>,
  updatedSections: GeneratedSectionSummary[]
): Array<{ sectionId: string; reason: string }> {
  const written = new Set(updatedSections.map((summary) => summary.sectionId));
  const seen = new Set<string>();
  const result: Array<{ sectionId: string; reason: string }> = [];
  for (const entry of skipped) {
    if (written.has(entry.sectionId) || seen.has(entry.sectionId)) {
      continue;
    }
    seen.add(entry.sectionId);
    result.push(entry);
  }
  return result;
}

function collectAllowedBlocksForSection(
  section: DocSection,
  entities: Record<string, CodeEntity>
): { allowedBlocks: BlockId[]; skippedBlocks: BlockSkipReason[] } {
  const ownedMetadata = section.owns
    .map((entityId) => entities[entityId]?.metadata)
    .filter((meta): meta is NonNullable<typeof meta> => Boolean(meta));

  if (ownedMetadata.length === 0) {
    return { allowedBlocks: [...BLOCK_IDS], skippedBlocks: [] };
  }

  const includedUnion = new Set<BlockId>();
  for (const meta of ownedMetadata) {
    for (const blockId of meta.allowedBlocks) {
      includedUnion.add(blockId);
    }
  }

  const skippedReasons = new Map<BlockId, string>();
  for (const meta of ownedMetadata) {
    for (const { blockId, reason } of meta.skippedBlocks) {
      if (includedUnion.has(blockId)) {
        continue;
      }
      if (!skippedReasons.has(blockId)) {
        skippedReasons.set(blockId, reason);
      }
    }
  }

  return {
    allowedBlocks: BLOCK_IDS.filter((blockId) => includedUnion.has(blockId)),
    skippedBlocks: [...skippedReasons.entries()].map(([blockId, reason]) => ({ blockId, reason })),
  };
}

function buildRewriteInstructions(
  targets: BlockId[],
  allowedBlocks: BlockId[],
  skippedBlocks: BlockSkipReason[]
): string {
  const targetList = targets.map((id) => `  - ${id}`).join("\n");
  const frozen = allowedBlocks.filter((id) => !targets.includes(id));
  const frozenList =
    frozen.length === 0
      ? ""
      : `\nRead-only context (already filled, do not regenerate): the other blocks in section.blocks under these ids:\n${frozen
          .map((id) => `  - ${id}`)
          .join("\n")}\n`;
  const skippedList =
    skippedBlocks.length === 0
      ? ""
      : `\nOmit these blocks (static analysis decided they are not informative for this section):\n${skippedBlocks
          .map(({ blockId, reason }) => `  - ${blockId}: ${reason}`)
          .join("\n")}\n`;

  return [
    "Return generatedBlocks ONLY for the targets listed below. Each block must include text, novelFact, informativeness, novelty, and specificity.",
    "Codelore stores all blocks in JSON and renders .md from JSON. Filtered blocks (low score) are kept in state with rendered=false and skipped in the .md output.",
    "",
    `Generate ONLY these target block ids:\n${targetList}`,
    frozenList,
    skippedList,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function resolveTargets(requested: BlockId[] | undefined, allowedBlocks: BlockId[], sectionId: string): BlockId[] {
  if (!requested || requested.length === 0) {
    return allowedBlocks;
  }
  const allowed = new Set(allowedBlocks);
  const invalid = requested.filter((id) => !allowed.has(id));
  if (invalid.length > 0) {
    throw new CodeloreError(
      "MISSING_BLOCK",
      `Targets ${invalid.join(", ")} are not in allowedBlocks for section "${sectionId}"`,
      { sectionId, invalid, allowedBlocks }
    );
  }
  return BLOCK_IDS.filter((id) => requested.includes(id));
}

/** Rendered, non-stale, non-empty blocks of a doc — the set eligible for translation. */
function* translatableBlocks(
  state: DocState
): Generator<{ sectionId: string; blockId: BlockId; block: DocStateBlock }> {
  for (const [sectionId, section] of Object.entries(state.sections)) {
    for (const blockId of section.allowedBlocks) {
      const block = section.blocks[blockId];
      if (!block || !block.rendered || block.staleSince !== undefined || block.body.trim() === "") {
        continue;
      }
      yield { sectionId, blockId, block };
    }
  }
}

/**
 * A block's translation for `language` is current when it exists, its source
 * fingerprint matches the canonical body, and it passes the translation guards
 * (code spans intact, not an untranslated echo). A stored translation that fails
 * the guards is treated as not current, so it is regenerated and self-heals.
 */
function isTranslationCurrent(block: DocStateBlock, language: string): boolean {
  const translation = block.translations?.[language];
  return (
    translation !== undefined &&
    translation.sourceFingerprint === translationSourceFingerprint(block.body) &&
    !translationNeedsWork(block.body, translation.body)
  );
}

/** Drops block translations for languages no longer configured. Returns true if any were removed. */
function pruneTranslations(state: DocState, keep: ReadonlySet<string>): boolean {
  let mutated = false;
  for (const section of Object.values(state.sections)) {
    for (const block of Object.values(section.blocks)) {
      if (!block.translations) {
        continue;
      }
      for (const language of Object.keys(block.translations)) {
        if (!keep.has(language)) {
          delete block.translations[language];
          mutated = true;
        }
      }
    }
  }
  return mutated;
}

/** The source-file path an owned entity id belongs to, or undefined for a tier (domain:/project:) id. */
/**
 * Splits section ids into source-code section ids (for the file pipeline) and tier
 * slugs (for the domain pipeline). A tier section id IS its entity id — `domain:<slug>`
 * or `project:` — so the split needs no index; the project uses the sentinel slug `.`.
 */
function splitTierSections(sectionIds: string[]): { sourceIds: string[]; tierSlugs: Set<string> } {
  const sourceIds: string[] = [];
  const tierSlugs = new Set<string>();
  for (const id of sectionIds) {
    if (id.startsWith(DOMAIN_ID_PREFIX)) {
      tierSlugs.add(id.slice(DOMAIN_ID_PREFIX.length));
    } else if (id === PROJECT_ID) {
      tierSlugs.add(".");
    } else {
      sourceIds.push(id);
    }
  }
  return { sourceIds, tierSlugs };
}

/** The member docs concatenated into one text — the ground truth the tier writer's blocks are verified against. */
function memberEvidenceText(members: DomainWriteMember[]): string {
  const parts: string[] = [];
  for (const member of members) {
    for (const section of member.sections) {
      const body = [section.purpose, section.responsibility].filter(Boolean).join(" ");
      if (body) {
        parts.push(`${member.label} — ${section.heading}: ${body}`);
      }
    }
  }
  return parts.join("\n");
}

function sourceFilePathOf(entityId: string): string | undefined {
  if (entityId.startsWith("file:")) {
    return entityId.slice("file:".length);
  }
  if (entityId.startsWith("symbol:")) {
    const hash = entityId.indexOf("#");
    return hash > 0 ? entityId.slice("symbol:".length, hash) : entityId.slice("symbol:".length);
  }
  return undefined;
}

/** Guards against silently truncating a partition: throws when the prompt exceeds the model's budget. */
function assertRequestFitsBudget(request: ChatCompletionInput, provider: ChatCompletionProvider): void {
  const chars = request.messages.reduce((sum, message) => sum + message.content.length, 0);
  const { maxPromptTokens, charsPerToken } = provider.writerBudget;
  const estimatedTokens = Math.ceil(chars / charsPerToken);
  if (estimatedTokens > maxPromptTokens) {
    throw new CodeloreError(
      "PARTITION_TOO_LARGE",
      `Domain partition needs ~${estimatedTokens} prompt tokens but the model budget is ${maxPromptTokens}. Batched partition is not yet implemented.`,
      { estimatedTokens, maxPromptTokens }
    );
  }
}

function appendPartitionRetry(
  request: ChatCompletionInput,
  previousContent: string,
  error: CodeloreError
): ChatCompletionInput {
  const cause = typeof error.details?.cause === "string" ? error.details.cause : error.message;
  return {
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: previousContent },
      {
        role: "user",
        content: `Your partition was rejected: ${cause}\nReturn ONLY the corrected JSON object. Every listed file must be assigned to exactly one domain.`,
      },
    ],
  };
}

// Unused but kept for future external consumers:
export type { CodeIndex };
