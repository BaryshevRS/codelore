import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { CodeloreError } from "../errors.js";
import type { BlockId } from "../markdown/block-ids.js";
import { translationDocPath } from "../markdown/doc-paths.js";
import {
  addDocToLinkMap,
  buildEntityLinkMap,
  type DocInfo,
  docLead,
  type LinkTarget,
  removeDocFromLinkMap,
} from "../markdown/linkify.js";
import { renderDoc } from "../markdown/render-doc.js";
import type { CodeloreConfig, DocState, DocStateBlock } from "../types.js";

export const DOC_STATE_VERSION = 4;
const STATE_SUBDIR = "state";
const CODELORE_MD_SUFFIX = ".codelore.md";

export function computeConfigFingerprint(config: CodeloreConfig): string {
  const canonical = stableStringify({
    thresholds: config.thresholds,
    blockHeadings: config.docs.blockHeadings,
    translations: config.docs.translations,
    blockHeadingsByLanguage: config.docs.blockHeadingsByLanguage,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function splitDocPath(docPath: string): { base: string; suffix: string } {
  if (docPath.endsWith(CODELORE_MD_SUFFIX)) {
    return { base: docPath.slice(0, -CODELORE_MD_SUFFIX.length), suffix: CODELORE_MD_SUFFIX };
  }
  if (docPath.endsWith(".md")) {
    return { base: docPath.slice(0, -".md".length), suffix: ".md" };
  }
  return { base: docPath, suffix: "" };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// Blocks listed as always-allowed in CLAUDE.md serve as the section's header;
// dropping them at render time leaves the heading without a one-liner, which is
// worse than a generic-but-true line. We respect explicit perBlockScore overrides.
const ALWAYS_RENDER_BLOCKS: ReadonlySet<BlockId> = new Set(["purpose", "responsibility"]);

function effectiveThreshold(config: CodeloreConfig, blockId: BlockId): number {
  const override = config.thresholds.perBlockScore?.[blockId];
  if (override !== undefined) {
    return override;
  }
  if (ALWAYS_RENDER_BLOCKS.has(blockId)) {
    return 0;
  }
  return config.thresholds.minScore;
}

function blockFinalScore(block: DocStateBlock): number | undefined {
  if (!block.scores) {
    return undefined;
  }
  return Math.min(block.scores.informativeness, block.scores.novelty, block.scores.specificity);
}

export function applyRenderDecision(state: DocState, config: CodeloreConfig): void {
  for (const section of Object.values(state.sections)) {
    for (const blockId of section.allowedBlocks) {
      const block = section.blocks[blockId];
      if (!block) {
        continue;
      }
      if (block.body.trim().length === 0) {
        block.rendered = false;
        // An empty block has no documentation to go stale; a lingering marker
        // would re-target the section on every fix-stale run forever.
        block.staleSince = undefined;
        block.staleReason = undefined;
        block.staleFacets = undefined;
        continue;
      }
      const score = blockFinalScore(block);
      if (score === undefined) {
        // No scores recorded yet (skeleton or migrated): keep prior decision.
        continue;
      }
      block.rendered = score >= effectiveThreshold(config, blockId as BlockId);
    }
  }
}

/** The render context derived from every doc state: cross-doc links and per-doc heading/lead. */
interface RenderContext {
  links: Map<string, LinkTarget>;
  docInfo: Map<string, DocInfo>;
}

function docInfoOf(state: DocState): DocInfo | undefined {
  const firstSection = state.sections[state.sectionOrder[0]];
  if (!firstSection) {
    return undefined;
  }
  const lead = docLead(state);
  return lead === undefined ? { heading: firstSection.heading } : { heading: firstSection.heading, lead };
}

export class DocStateStorage {
  /**
   * Lazily built render context (cross-doc link map + per-doc heading/lead), kept
   * coherent with every state write/delete that goes through this instance.
   * Memoized as a promise so concurrent renders share one disk scan.
   */
  private renderContextPromise?: Promise<RenderContext>;

  constructor(private readonly config: CodeloreConfig) {}

  private renderContext(): Promise<RenderContext> {
    this.renderContextPromise ??= this.buildRenderContext();
    return this.renderContextPromise;
  }

  private async buildRenderContext(): Promise<RenderContext> {
    const states: DocState[] = [];
    const docInfo = new Map<string, DocInfo>();
    for (const docPath of await this.listDocStates()) {
      const state = await this.loadDocState(docPath);
      if (state) {
        states.push(state);
        const info = docInfoOf(state);
        if (info) {
          docInfo.set(state.docPath, info);
        }
      }
    }
    return { links: buildEntityLinkMap(states), docInfo };
  }

  async loadDocState(docPath: string): Promise<DocState | undefined> {
    const absolutePath = this.statePathFor(docPath);
    try {
      const raw = await readFile(absolutePath, "utf8");
      const state = JSON.parse(raw) as DocState;
      if (state.version !== DOC_STATE_VERSION) {
        // Restamping the version would hand the rest of the pipeline a state whose shape
        // does not match the fields it reads, and writing it back would drop whatever a
        // newer codelore added. Neither is recoverable, so stop with an actionable message.
        throw new CodeloreError(
          "UNSUPPORTED_STATE_VERSION",
          state.version > DOC_STATE_VERSION
            ? `Doc state "${docPath}" was written by a newer codelore (schema version ${state.version}; this build reads ${DOC_STATE_VERSION}). Upgrade codelore.`
            : `Doc state "${docPath}" uses schema version ${state.version}; this build reads ${DOC_STATE_VERSION}. Delete ${absolutePath} and regenerate the doc.`,
          { docPath, stateVersion: state.version, supportedVersion: DOC_STATE_VERSION }
        );
      }
      return state;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async saveDocState(state: DocState): Promise<void> {
    const absolutePath = this.statePathFor(state.docPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const tmpPath = `${absolutePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmpPath, absolutePath);
    if (this.renderContextPromise) {
      const context = await this.renderContextPromise;
      addDocToLinkMap(context.links, state);
      const info = docInfoOf(state);
      if (info) {
        context.docInfo.set(state.docPath, info);
      } else {
        context.docInfo.delete(state.docPath);
      }
    }
  }

  async deleteDocState(docPath: string): Promise<void> {
    await rm(this.statePathFor(docPath), { force: true });
    if (this.renderContextPromise) {
      const context = await this.renderContextPromise;
      removeDocFromLinkMap(context.links, docPath);
      context.docInfo.delete(docPath);
    }
  }

  /** Remove the JSON state, the rendered .md, and every translation .md for a doc that no longer has sections. */
  async deleteDoc(docPath: string): Promise<void> {
    await this.deleteDocState(docPath);
    await rm(join(this.config.rootDir, docPath), { force: true });
    // Drop every translation sibling regardless of current config — the whole doc is gone.
    await this.cleanupTranslationFiles(docPath, new Set());
  }

  async renderAndPersist(state: DocState): Promise<void> {
    applyRenderDecision(state, this.config);
    state.configFingerprint = computeConfigFingerprint(this.config);
    await this.saveDocState(state);
    const { links, docInfo } = await this.renderContext();
    await this.writeDocFile(state.docPath, renderDoc(state, this.config, undefined, links, docInfo));
    for (const language of this.config.docs.translations) {
      await this.writeDocFile(
        translationDocPath(state.docPath, language),
        renderDoc(state, this.config, language, links, docInfo)
      );
    }
    await this.cleanupTranslationFiles(state.docPath, new Set(this.config.docs.translations));
  }

  private async writeDocFile(docPath: string, markdown: string): Promise<void> {
    const docAbsolutePath = join(this.config.rootDir, docPath);
    await mkdir(dirname(docAbsolutePath), { recursive: true });
    const tmpPath = `${docAbsolutePath}.tmp`;
    await writeFile(tmpPath, markdown, "utf8");
    await rename(tmpPath, docAbsolutePath);
  }

  /**
   * Remove translation .md siblings of `docPath` whose language is not in `keep`.
   * Translation files have no backing JSON state, so any sibling that matches the
   * `<base>.<lang><suffix>` pattern AND has its own state is a separate real doc and
   * is left untouched — only stateless orphans of this doc are deleted.
   */
  private async cleanupTranslationFiles(docPath: string, keep: ReadonlySet<string>): Promise<void> {
    const { base, suffix } = splitDocPath(docPath);
    if (suffix === "") {
      return;
    }
    const dirRelative = dirname(docPath);
    const dirAbsolute = join(this.config.rootDir, dirRelative);
    const baseName = basename(base);
    const pattern = new RegExp(`^${escapeRegExp(baseName)}\\.(.+)${escapeRegExp(suffix)}$`);
    let entries: string[];
    try {
      entries = await readdir(dirAbsolute);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (!match || keep.has(match[1])) {
        continue;
      }
      const candidateDocPath = dirRelative === "." ? entry : `${dirRelative}/${entry}`;
      if (existsSync(this.statePathFor(candidateDocPath))) {
        continue;
      }
      await rm(join(dirAbsolute, entry), { force: true });
    }
  }

  /**
   * Re-render every doc from its JSON state. A doc whose stored config
   * fingerprint diverged is fully re-persisted (render decisions may change); a
   * doc whose rendered markdown merely drifted — a cross-doc link target
   * appeared or moved since it was last written — gets its .md rewritten in
   * place, JSON state untouched. Idempotent. `updated` lists only the
   * re-persisted docs (the ones whose state changed).
   */
  async reconcileRenderedDocs(): Promise<{ updated: string[] }> {
    const current = computeConfigFingerprint(this.config);
    const updated: string[] = [];
    const { links, docInfo } = await this.renderContext();
    for (const docPath of await this.listDocStates()) {
      const state = await this.loadDocState(docPath);
      if (!state) {
        continue;
      }
      if (state.configFingerprint !== current) {
        await this.renderAndPersist(state);
        updated.push(docPath);
        continue;
      }
      await this.writeDocFileIfChanged(state.docPath, renderDoc(state, this.config, undefined, links, docInfo));
      for (const language of this.config.docs.translations) {
        await this.writeDocFileIfChanged(
          translationDocPath(state.docPath, language),
          renderDoc(state, this.config, language, links, docInfo)
        );
      }
    }
    return { updated };
  }

  private async writeDocFileIfChanged(docPath: string, markdown: string): Promise<void> {
    let existing: string | undefined;
    try {
      existing = await readFile(join(this.config.rootDir, docPath), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (existing !== markdown) {
      await this.writeDocFile(docPath, markdown);
    }
  }

  async listDocStates(): Promise<string[]> {
    const root = this.stateRoot();
    try {
      return (await collectJsonFiles(root)).map((absolute) => this.docPathFromStateFile(absolute));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  statePathFor(docPath: string): string {
    return join(this.stateRoot(), `${stripMarkdownExtension(docPath)}.json`);
  }

  private stateRoot(): string {
    return join(this.config.rootDir, this.config.indexDir, STATE_SUBDIR);
  }

  private docPathFromStateFile(absoluteStatePath: string): string {
    const rel = relative(this.stateRoot(), absoluteStatePath).split(sep).join("/");
    return rel.replace(/\.json$/, ".md");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMarkdownExtension(docPath: string): string {
  return docPath.replace(/\.md$/, "");
}

async function collectJsonFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectJsonFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes(".generation-debug.")) {
      result.push(absolute);
    }
  }
  return result;
}
