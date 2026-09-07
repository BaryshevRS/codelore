import { stat } from "node:fs/promises";
import { join } from "node:path";
import fastGlob from "fast-glob";
import { buildCodeIndex, type CodeIndexScope } from "../indexer/code-indexer.js";
import { buildDomainEntities } from "../indexer/domain-entities.js";
import { buildDocIndex, patchDocIndexPaths } from "../indexer/state-indexer.js";
import type { DocStateStorage } from "../storage/doc-state-storage.js";
import type { JsonStorage } from "../storage/json-storage.js";
import type { CodeloreConfig, ProjectIndex } from "../types.js";
import { INDEX_VERSION } from "../types.js";

export interface RebuildIndexesOptions {
  persist?: boolean;
  renderDocs?: boolean;
}

/**
 * Owns the in-memory project-index cache and all index (re)building. Whenever
 * the cached index is replaced (rebuild) or mutated in place (patch), it calls
 * onIndexChanged so the service can drop caches derived from the index.
 */
export class IndexManager {
  private cache?: ProjectIndex;

  constructor(
    private readonly config: CodeloreConfig,
    private readonly storage: JsonStorage,
    private readonly docStateStorage: DocStateStorage,
    private readonly onIndexChanged: () => void
  ) {}

  get cached(): ProjectIndex | undefined {
    return this.cache;
  }

  async rebuild(options: RebuildIndexesOptions = {}): Promise<ProjectIndex> {
    if (options.renderDocs ?? false) {
      await this.docStateStorage.reconcileRenderedDocs();
    }
    const [code, docs, domainMap] = await Promise.all([
      buildCodeIndex(this.config),
      buildDocIndex(this.config, this.docStateStorage),
      this.storage.loadDomainMap(),
    ]);
    // Domain/project tiers are derived from the full file set plus the domain map;
    // they live only on the full cached index, so every reconcile/validate path
    // (which reads the cache) sees them. A scoped code build never carries them.
    if (domainMap) {
      Object.assign(code.entities, buildDomainEntities(code, domainMap));
    }
    const index: ProjectIndex = {
      version: INDEX_VERSION,
      generatedAt: new Date().toISOString(),
      code,
      docs,
    };
    if (options.persist ?? false) {
      await this.storage.saveProjectIndex(index);
    }
    this.cache = index;
    this.onIndexChanged();
    return index;
  }

  async loadOrRebuild(): Promise<ProjectIndex> {
    if (this.cache) {
      return this.cache;
    }
    const loaded = await this.storage.loadProjectIndex();
    const index =
      loaded && (await persistedIndexIsFresh(this.config, loaded)) ? loaded : await this.rebuild({ renderDocs: false });
    this.cache = index;
    return index;
  }

  /**
   * Refresh only the doc-derived index for doc paths whose JSON state changed
   * (block rewrites, status flips, stale marks). Source code is untouched by
   * those mutations, so the cached code index stays valid — this skips the
   * full-project ts-morph reparse that rebuild performs. Callers always
   * loadOrRebuild first, so the cache is populated; the cold fallback is
   * defensive.
   */
  async patchDocs(docPaths: string[]): Promise<void> {
    if (!this.cache) {
      await this.rebuild();
      return;
    }
    await patchDocIndexPaths(this.cache.docs, this.config, this.docStateStorage, docPaths);
    this.cache.generatedAt = this.cache.docs.generatedAt;
    this.onIndexChanged();
  }

  /**
   * Build a one-off index (optionally scoped) without touching the cache. Used
   * by prepareInitialDocs to inspect a subset of the project before writing.
   */
  async buildScopedIndex(scope: CodeIndexScope | undefined): Promise<ProjectIndex> {
    const [code, docs] = await Promise.all([
      buildCodeIndex(this.config, scope),
      buildDocIndex(this.config, this.docStateStorage),
    ]);
    return {
      version: INDEX_VERSION,
      generatedAt: new Date().toISOString(),
      code,
      docs,
    };
  }
}

/**
 * The persisted index is a cache over the source tree and the doc state;
 * trusting it after either changed serves phantom (or missing) sections. The
 * index is fresh only if nothing it was built from is newer than generatedAt.
 * State directories are scanned too, so deletions bump the parent dir mtime.
 */
async function persistedIndexIsFresh(config: CodeloreConfig, index: ProjectIndex): Promise<boolean> {
  const generatedAt = Date.parse(index.generatedAt);
  if (Number.isNaN(generatedAt)) {
    return false;
  }
  const [sourcePaths, statePaths] = await Promise.all([
    fastGlob(config.sourceGlobs, {
      cwd: config.rootDir,
      onlyFiles: true,
      dot: true,
      unique: true,
      absolute: true,
      ignore: config.excludeGlobs,
    }),
    fastGlob(join(config.indexDir, "state/**"), {
      cwd: config.rootDir,
      onlyFiles: false,
      dot: true,
      unique: true,
      absolute: true,
    }),
  ]);
  const mtimes = await Promise.all(
    [...sourcePaths, ...statePaths].map(async (path) => {
      try {
        return (await stat(path)).mtimeMs;
      } catch {
        // Deleted between glob and stat; the parent directory mtime covers it.
        return 0;
      }
    })
  );
  return mtimes.every((mtime) => mtime <= generatedAt);
}
