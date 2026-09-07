import type { BlockId } from "./markdown/block-ids.js";

export const INDEX_VERSION = 2;

export type EntityType = "file" | "function" | "method" | "class" | "domain" | "project";

export type SectionStatus = "normal" | "review_needed" | "stale";

export type AstFacet = "signature" | "body" | "deps" | "usage" | "placement";
/**
 * AST facets plus the non-AST facets used for cascade staleness: `depDocs` (a
 * dependency's docs changed), `owned` (the owned entity was deleted), and
 * `language` (the prose was written in a language that is no longer the canonical
 * `docs.language`).
 */
export type Facet = AstFacet | "depDocs" | "memberDocs" | "owned" | "language";

export interface EntityFacets {
  signature: string;
  body: string;
  deps: string;
  usage: string;
  placement: string;
}

export type DocumentationRole = "one_line" | "short_page" | "full_page" | "absorbed" | "absorbed_by_caller";

export interface SourceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface CodeEntity {
  id: string;
  type: EntityType;
  path: string;
  name: string;
  signature: string;
  range: SourceRange;
  directDeps: string[];
  directUsages: string[];
  contentHash: string;
  facets: EntityFacets;
  metadata?: EntityMetadata;
}

export interface EntityImportSpecifier {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  /** Project-relative path of the resolved module (TS resolver), when local and resolvable. */
  resolvedPath?: string;
  isTypeOnly: boolean;
  isStdlib: boolean;
  isExternal: boolean;
  isReferenced: boolean;
}

export interface EntityImports {
  specifiers: EntityImportSpecifier[];
}

export interface EntityGlobalUsage {
  name: string;
  access: string;
}

export interface EntityGlobals {
  used: EntityGlobalUsage[];
}

export interface EntityMetrics {
  statementCount: number;
  inDegree: number;
  hasSideEffects: boolean;
  isEntryPoint: boolean;
  imports: EntityImports;
  globals: EntityGlobals;
}

export interface BlockSkipReason {
  blockId: BlockId;
  reason: string;
}

export interface EntityDocumentationDecision {
  weight: number;
  role: DocumentationRole;
  anchorPrivate?: string;
  absorbedBy?: string;
  reason?: string;
}

export interface EntityMetadata extends EntityMetrics, EntityDocumentationDecision {
  allowedBlocks: BlockId[];
  skippedBlocks: BlockSkipReason[];
}

export interface CodeIndex {
  version: number;
  generatedAt: string;
  rootDir: string;
  entities: Record<string, CodeEntity>;
  fileToEntities: Record<string, string[]>;
}

export interface DocBlock {
  id: string;
  heading: string;
  depth: number;
  body: string;
  rendered: boolean;
  language?: string;
  staleSince?: string;
  staleReason?: string;
  staleFacets?: Facet[];
  scores?: DocStateBlockScores;
}

export interface DocSection {
  id: string;
  docPath: string;
  heading: string;
  depth: number;
  anchor: string;
  owns: string[];
  depends: string[];
  usedBy: string[];
  blocks: DocBlock[];
  status: SectionStatus;
  blockFingerprints: Record<string, string>;
  allowedBlocks: BlockId[];
  depDocsFingerprint?: string;
  /** Hash of the member docs a tier (domain/project) section summarizes; drift flags the `memberDocs` facet. */
  memberDocsFingerprint?: string;
}

export interface DocIndex {
  version: number;
  generatedAt: string;
  rootDir: string;
  sections: Record<string, DocSection>;
  fileToSections: Record<string, string[]>;
  entityToSections: Record<string, string[]>;
}

export interface ProjectIndex {
  version: number;
  generatedAt: string;
  code: CodeIndex;
  docs: DocIndex;
}

export interface DocStateBlockScores {
  informativeness: number;
  novelty: number;
  specificity: number;
  novelFact: string;
}

/**
 * A derived translation of a block's canonical `body`. `sourceFingerprint` hashes
 * the canonical body it was translated from; when the canonical body changes the
 * hash diverges and the translation is treated as stale until the translate pass
 * refills it. The translation is never verified against the code — it inherits the
 * canonical block's correctness and only preserves its code refs verbatim.
 */
export interface DocStateBlockTranslation {
  body: string;
  sourceFingerprint: string;
}

export interface DocStateBlock {
  body: string;
  rendered: boolean;
  fingerprint?: string;
  /**
   * The canonical `docs.language` the `body` prose was written in, stamped at
   * generation. Undefined for blocks generated before language stamping existed.
   * A mismatch with the current canonical language marks the block stale via the
   * `language` facet.
   */
  language?: string;
  staleSince?: string;
  staleReason?: string;
  staleFacets?: Facet[];
  scores?: DocStateBlockScores;
  /** Derived per-language translations of `body`, keyed by language code. */
  translations?: Record<string, DocStateBlockTranslation>;
}

export interface GenerationHistoryEntry {
  runId: string;
  timestamp: string;
  command: string;
  intent?: string;
  provider: string;
  model: string;
  generatedBlocks: BlockId[];
  manualReviewNeeded?: boolean;
}

export interface DocStateSection {
  heading: string;
  depth: number;
  anchor: string;
  /**
   * The owned entity's typed signature, stamped at section creation and
   * re-derived on rewrite. Rendered as a fenced code line under the section
   * heading. Absent for file-owned sections (their signature is just the path)
   * and for states written before signature stamping existed.
   */
  signature?: string;
  owns: string[];
  depends: string[];
  usedBy: string[];
  status: SectionStatus;
  allowedBlocks: BlockId[];
  blockOrder: BlockId[];
  blocks: Record<string, DocStateBlock>;
  generationHistory?: GenerationHistoryEntry[];
  depDocsFingerprint?: string;
  /** Hash of the member docs a tier (domain/project) section summarizes; drift flags the `memberDocs` facet. */
  memberDocsFingerprint?: string;
}

export interface DocState {
  version: number;
  docPath: string;
  generatedAt: string;
  configFingerprint?: string;
  sectionOrder: string[];
  sections: Record<string, DocStateSection>;
}

export interface RebuildIndexInput {
  verbose?: boolean;
}

export interface RebuildIndexResult {
  ok: true;
  version: number;
  generatedAt: string;
  codeEntities: number;
  codeFiles: number;
  docSections: number;
  docFiles: number;
  index?: ProjectIndex;
}

export interface AffectedSection {
  sectionId: string;
  reason: string;
  order: number;
}

export interface ChangeAnalysis {
  id: string;
  generatedAt: string;
  changedFiles: string[];
  changedEntities: string[];
  affectedSections: AffectedSection[];
}

export type CodeEntitySummary = Pick<
  CodeEntity,
  "id" | "type" | "path" | "name" | "signature" | "range" | "contentHash" | "metadata"
> & {
  directDepCount: number;
  directUsageCount: number;
};

export type DocBlockSummary = Pick<
  DocBlock,
  "id" | "heading" | "depth" | "body" | "rendered" | "staleSince" | "staleReason" | "staleFacets"
>;

export type DocSectionSummary = Pick<
  DocSection,
  "id" | "docPath" | "heading" | "depth" | "anchor" | "owns" | "depends" | "usedBy" | "status" | "allowedBlocks"
> & {
  blocks: DocBlockSummary[];
};

export interface ProjectContext {
  text: string;
  sources: string[];
}

export interface SectionContext {
  section: DocSectionSummary;
  targets: BlockId[];
  rewriteInstructions: string;
  owns: CodeEntitySummary[];
  depends: CodeEntitySummary[];
  directUsages: CodeEntitySummary[];
  neighborSections: Array<Pick<DocSection, "id" | "heading" | "status">>;
  allowedBlocks: BlockId[];
  skippedBlocks: BlockSkipReason[];
  reason?: string;
  projectContext?: ProjectContext;
}

export interface RuntimeEvidence {
  literal: string;
  syntaxRole: string;
  callsite: { line: number; column: number };
}

export interface RuntimeHit {
  entityId: string;
  literalValue: string;
  syntaxRole: string;
  callsite: { line: number; column: number };
}

export interface RewriteSectionInput {
  sectionId: string;
  generatedBlocks: Partial<Record<BlockId, GeneratedBlock>>;
  showFiltered?: boolean;
}

export interface GeneratedBlock {
  text: string;
  novelFact: string;
  reasoning?: string;
  informativeness: number;
  novelty: number;
  specificity: number;
}

export interface FilteredGeneratedBlock {
  blockId: BlockId;
  novelFact: string;
  informativeness: number;
  novelty: number;
  specificity: number;
  finalScore: number;
  threshold: number;
  text?: string;
}

/**
 * A glob-scoped set of preferred terms. `match` (a path glob like `src/graph/**`)
 * limits the group to files under a module; absent = the whole project. `byLanguage`
 * holds one list per language code — the writer reads the canonical language's list,
 * the translator reads its target's.
 */
export interface TermGroup {
  match?: string;
  byLanguage: Record<string, string[]>;
}

export interface DocsConfig {
  /** Canonical language: the one the grounded pipeline writes and verifies. */
  language?: string;
  /** Additional languages the canonical prose is translated into (derived, not verified). */
  translations: string[];
  /** Prose voice/style rules; language-agnostic, one set applied to writer and translator alike. */
  writingRules: string[];
  /** Preferred terminology in glob-scoped groups: global first, then per-module overlays. */
  terms: TermGroup[];
  /** Block headings for the canonical language (with any per-label override applied). */
  blockHeadings: Record<BlockId, string>;
  /** Resolved block headings per language (canonical + every translation), no overrides for translations. */
  blockHeadingsByLanguage: Record<string, Record<BlockId, string>>;
}

export interface PreparedDocSection {
  entityId: string;
  sectionId: string;
  docPath: string;
}

export interface SkippedPreparedDocSection {
  entityId: string;
  reason: "already_documented";
  sectionIds: string[];
  docPaths: string[];
}

export interface PrepareInitialDocsInput {
  paths?: string[];
  files?: string[];
  entityIds?: string[];
  dryRun?: boolean;
}

export type PrepareInitialDocsNextAction =
  | "run_without_dry_run"
  | "fill_created_sections"
  | "stop_already_documented"
  | "stop_no_matching_entities";

export interface PrepareInitialDocsResult {
  dryRun: boolean;
  scope: {
    paths: string[];
    files: string[];
    entityIds: string[];
  };
  nextAction: PrepareInitialDocsNextAction;
  guidance: string;
  summary: {
    scopeMode: "all" | "scoped";
    totalCodeEntities: number;
    indexedCodeEntities: number;
    indexedCodeFiles: number;
    scopedEntities: number;
    alreadyDocumentedEntities: number;
    missingEntities: number;
    plannedSections: number;
    createdSections: number;
  };
  plannedSections: PreparedDocSection[];
  createdSections: PreparedDocSection[];
  skippedSections: SkippedPreparedDocSection[];
  skippedBlocksByEntity: Array<{ entityId: string; skipped: BlockSkipReason[] }>;
}

export type RefreshStaleMode = "report" | "rewrite_plan" | "tombstone";

export interface RefreshStaleScope {
  sectionIds?: string[];
  files?: string[];
  paths?: string[];
}

export interface RefreshStaleDocsInput {
  mode?: RefreshStaleMode;
  scope?: RefreshStaleScope;
}

export interface StaleBlockInfo {
  sectionId: string;
  docPath: string;
  blockId: string;
  blockHeading: string;
  changedFacets: Facet[];
  drift: "facet_changed" | "tombstoned" | "owned_entity_deleted";
}

export interface RewriteContextBundle {
  sectionId: string;
  docPath: string;
  blockId: string;
  blockHeading: string;
  targets: BlockId[];
  changedFacets: Facet[];
  currentText: string;
  owns: CodeEntitySummary[];
  reason: string;
}

export interface RefreshStaleDocsResult {
  mode: RefreshStaleMode;
  summary: {
    stale: number;
    tombstoned: number;
    appliedTombstones: number;
  };
  stale: StaleBlockInfo[];
  tombstoned: StaleBlockInfo[];
  appliedTombstones?: Array<{ sectionId: string; blockId: string; docPath: string }>;
  rewritePlan?: RewriteContextBundle[];
}

export interface DocValidationIssue {
  code:
    | "broken_dependency"
    | "empty_required_block"
    | "stale_block"
    | "stale_owned_entity"
    | "missing_translation"
    | "uncovered_file";
  severity: "error" | "warning" | "info";
  sectionId: string;
  docPath: string;
  message: string;
  entityId?: string;
  blockId?: string;
  changedFacets?: Facet[];
  drift?: "facet_changed" | "tombstoned" | "owned_entity_deleted";
}

export interface BlockInclusionConfig {
  enabled: boolean;
  stdlibPrefixes: string[];
  significantGlobals: string[];
}

export interface OpenAiCompatibleProviderConfig {
  type: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  temperature?: number;
  timeoutMs?: number;
  /** Model context window in tokens; the writer prompt budget is derived from it. */
  contextWindow?: number;
  /** Tokens held back from the context window for the model's response. */
  reservedOutputTokens?: number;
  /** Chars-per-token for this model; converts a measured payload's chars to an estimated token count. */
  charsPerToken?: number;
  /** Max doc sections per writer call; caps response size so slow providers fit their timeout. */
  maxSectionsPerChunk?: number;
  /**
   * Structured-output capability of this endpoint, opt-in per provider.
   * - "json_object": sends `response_format: {type: "json_object"}` — guarantees
   *   parseable JSON syntax only (no fences, no truncation), not the shape.
   * - "json_schema": sends `response_format: {type: "json_schema", json_schema:
   *   {strict: true, schema}}` when the request carries a response schema —
   *   constrained decoding, the model physically cannot misplace keys. Requests
   *   without a schema fall back to json_object (every json_schema-capable
   *   endpoint accepts it).
   * Requires the word "json" in the prompt, which the writer/verifier system
   * prompts already carry.
   */
  responseFormat?: "json_object" | "json_schema";
}

export type LlmProviderConfig = OpenAiCompatibleProviderConfig;

/** Resolved writer-chunk budget for the active model (all magic numbers come from provider config). */
export interface WriterBudget {
  /** Max prompt tokens = contextWindow − reservedOutputTokens. */
  maxPromptTokens: number;
  /** Chars-per-token used to convert a measured payload's chars to an estimated token count. */
  charsPerToken: number;
  /** Max doc sections per writer call. */
  maxSectionsPerChunk: number;
}

export interface LlmConfig {
  provider: string;
  providers: Record<string, LlmProviderConfig>;
  /**
   * Provider for the fact-check stages (verification, factRecheck) — the cheaper
   * half of the pipeline, since checking a claim against a slice is easier than
   * writing the doc. Names an entry in `providers`; unset → the writer provider
   * runs verification too. Repair stays on the writer provider (it rewrites prose).
   */
  verifyProvider?: string;
  /**
   * Provider for the one-shot domain partition (`partitionDomainMap`). Clustering
   * documented files into subsystems by responsibility is where depth pays off, so
   * this runs on the strongest model even when the writer is cheaper; the pass is
   * rare and sized by documented-file count, not repo size. Names an entry in
   * `providers`; unset → the writer provider. An explicit `--provider` overrides it.
   */
  partitionProvider?: string;
  concurrency: number;
  /** Include imported type declarations in the verification context (default true). */
  verifyTypeContext: boolean;
}

export interface CodeloreConfig {
  rootDir: string;
  sourceGlobs: string[];
  docGlobs: string[];
  excludeGlobs: string[];
  indexDir: string;
  docs: DocsConfig;
  thresholds: {
    weightMinimal: number;
    weightFull: number;
    minScore: number;
    classFieldOverlap: number;
    perBlockScore?: Record<string, number>;
  };
  blockInclusion: BlockInclusionConfig;
  llm: LlmConfig;
  sideEffectPatterns?: string[];
  entryPoints?: {
    barrelFiles?: string[];
    decorators?: string[];
    pathPatterns?: string[];
    explicit?: string[];
  };
}
