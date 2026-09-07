import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DOMAIN_MAP_VERSION, type DomainMap } from "../domains/domain-map.js";
import { type ChangeAnalysis, type CodeloreConfig, INDEX_VERSION, type ProjectIndex } from "../types.js";

export class JsonStorage {
  constructor(private readonly config: CodeloreConfig) {}

  async saveProjectIndex(index: ProjectIndex): Promise<void> {
    await this.writeJson(this.indexPath(), index);
  }

  async loadProjectIndex(): Promise<ProjectIndex | undefined> {
    const loaded = await this.readJson<ProjectIndex>(this.indexPath());
    if (!loaded || loaded.version !== INDEX_VERSION) {
      return undefined;
    }
    return loaded;
  }

  /** The domain map is committed source-of-truth (unlike the index cache); it sits beside state/. */
  async saveDomainMap(map: DomainMap): Promise<void> {
    await this.writeJson(this.domainMapPath(), map);
  }

  async loadDomainMap(): Promise<DomainMap | undefined> {
    const loaded = await this.readJson<DomainMap>(this.domainMapPath());
    if (!loaded || loaded.version !== DOMAIN_MAP_VERSION) {
      return undefined;
    }
    return loaded;
  }

  domainMapPath(): string {
    return join(this.config.rootDir, this.config.indexDir, "domains.codelore.json");
  }

  async saveChangeAnalysis(change: ChangeAnalysis): Promise<void> {
    await this.writeJson(this.changePath(change.id), change);
  }

  async loadChangeAnalysis(changeId: string): Promise<ChangeAnalysis | undefined> {
    return this.readJson<ChangeAnalysis>(this.changePath(changeId));
  }

  indexPath(): string {
    return join(this.config.rootDir, this.config.indexDir, "index.json");
  }

  changePath(changeId: string): string {
    return join(this.config.rootDir, this.config.indexDir, "changes", `${changeId}.json`);
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }
}
