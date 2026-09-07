import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { translationSourceFingerprint } from "../markdown/block-facets.js";
import { translationDocPath } from "../markdown/doc-paths.js";
import type { CodeloreConfig, DocState } from "../types.js";
import { computeConfigFingerprint, DOC_STATE_VERSION, DocStateStorage } from "./doc-state-storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DocStateStorage", () => {
  it("returns undefined when state file is missing", async () => {
    const { storage } = await createStorage();
    expect(await storage.loadDocState("src/foo.codelore.md")).toBeUndefined();
  });

  it("roundtrips state via save + load", async () => {
    const { storage } = await createStorage();
    const state: DocState = {
      version: DOC_STATE_VERSION,
      docPath: "src/foo.codelore.md",
      generatedAt: "2026-05-20T00:00:00.000Z",
      sectionOrder: ["file:src/foo.ts"],
      sections: {
        "file:src/foo.ts": {
          heading: "foo.ts",
          depth: 2,
          anchor: "foo-ts",
          owns: ["file:src/foo.ts"],
          depends: [],
          usedBy: [],
          status: "normal",
          allowedBlocks: ["purpose", "limitations"],
          blockOrder: ["purpose", "limitations"],
          blocks: {
            purpose: { body: "Purpose body.", rendered: true, fingerprint: "signature=abc" },
            limitations: {
              body: "Limitations body.",
              rendered: false,
              fingerprint: "body=xyz",
              staleSince: "2026-05-20T00:00:00.000Z",
              staleReason: "body_changed",
              staleFacets: ["body"],
              scores: { informativeness: 0.5, novelty: 0.4, specificity: 0.6, novelFact: "nf" },
            },
          },
        },
      },
    };

    await storage.saveDocState(state);
    expect(await storage.loadDocState("src/foo.codelore.md")).toStrictEqual(state);
  });

  it("places state files mirroring the doc path under .codelore/state/", async () => {
    const { storage } = await createStorage();
    const state: DocState = makeMinimalState("src/nested/dir/foo.codelore.md");
    await storage.saveDocState(state);

    const absolutePath = storage.statePathFor("src/nested/dir/foo.codelore.md");
    expect(absolutePath.endsWith(join(".codelore", "state", "src", "nested", "dir", "foo.codelore.json"))).toBe(true);
    await expect(readFile(absolutePath, "utf8")).resolves.toContain(`"docPath": "src/nested/dir/foo.codelore.md"`);
  });

  it("refuses a state file written by an older schema instead of restamping it", async () => {
    const { storage } = await createStorage();
    await storage.saveDocState(makeMinimalState("src/foo.codelore.md"));
    const statePath = storage.statePathFor("src/foo.codelore.md");
    const stored = JSON.parse(await readFile(statePath, "utf8")) as DocState;
    await writeFile(statePath, JSON.stringify({ ...stored, version: DOC_STATE_VERSION - 1 }), "utf8");

    await expect(storage.loadDocState("src/foo.codelore.md")).rejects.toMatchObject({
      code: "UNSUPPORTED_STATE_VERSION",
      details: { stateVersion: DOC_STATE_VERSION - 1, supportedVersion: DOC_STATE_VERSION },
    });
  });

  it("refuses a state file written by a newer schema", async () => {
    const { storage } = await createStorage();
    await storage.saveDocState(makeMinimalState("src/foo.codelore.md"));
    const statePath = storage.statePathFor("src/foo.codelore.md");
    const stored = JSON.parse(await readFile(statePath, "utf8")) as DocState;
    await writeFile(statePath, JSON.stringify({ ...stored, version: DOC_STATE_VERSION + 1 }), "utf8");

    await expect(storage.loadDocState("src/foo.codelore.md")).rejects.toThrow(/Upgrade codelore/);
  });

  it("deletes existing state files", async () => {
    const { storage } = await createStorage();
    await storage.saveDocState(makeMinimalState("src/foo.codelore.md"));
    await storage.deleteDocState("src/foo.codelore.md");
    expect(await storage.loadDocState("src/foo.codelore.md")).toBeUndefined();
  });

  it("lists docPaths for all existing state files", async () => {
    const { storage } = await createStorage();
    await storage.saveDocState(makeMinimalState("src/foo.codelore.md"));
    await storage.saveDocState(makeMinimalState("src/nested/bar.codelore.md"));

    const docPaths = await storage.listDocStates();
    expect(docPaths.sort()).toStrictEqual(["src/foo.codelore.md", "src/nested/bar.codelore.md"]);
  });

  it("listDocStates returns empty array if state dir does not exist yet", async () => {
    const { storage } = await createStorage();
    await expect(storage.listDocStates()).resolves.toStrictEqual([]);
  });

  it("renderAndPersist writes both JSON and rendered .md", async () => {
    const { storage, config } = await createStorage();
    const state: DocState = {
      version: DOC_STATE_VERSION,
      docPath: "src/foo.codelore.md",
      generatedAt: "2026-05-20T00:00:00.000Z",
      sectionOrder: ["s1"],
      sections: {
        s1: {
          heading: "Foo",
          depth: 2,
          anchor: "foo",
          owns: [],
          depends: [],
          usedBy: [],
          status: "normal",
          allowedBlocks: ["purpose"],
          blockOrder: ["purpose"],
          blocks: { purpose: { body: "Body.", rendered: true } },
        },
      },
    };

    await storage.renderAndPersist(state);

    expect(await storage.loadDocState("src/foo.codelore.md")).toStrictEqual(state);
    expect(state.configFingerprint).toBe(computeConfigFingerprint(config));
    const mdAbsolute = join(config.rootDir, state.docPath);
    await expect(readFile(mdAbsolute, "utf8")).resolves.toBe(
      `## Foo

### Purpose

Body.
`
    );
  });

  it("renderAndPersist clears stale markers on empty blocks", async () => {
    const { storage } = await createStorage();
    const state: DocState = {
      version: DOC_STATE_VERSION,
      docPath: "src/foo.codelore.md",
      generatedAt: "2026-05-20T00:00:00.000Z",
      sectionOrder: ["s1"],
      sections: {
        s1: {
          heading: "Foo",
          depth: 2,
          anchor: "foo",
          owns: [],
          depends: [],
          usedBy: [],
          status: "normal",
          allowedBlocks: ["purpose", "changeGuide"],
          blockOrder: ["purpose", "changeGuide"],
          blocks: {
            purpose: { body: "Body.", rendered: true },
            changeGuide: {
              body: "",
              rendered: false,
              staleSince: "2026-06-10T00:00:00.000Z",
              staleReason: "code_changed",
              staleFacets: ["body"],
            },
          },
        },
      },
    };

    await storage.renderAndPersist(state);

    const loaded = await storage.loadDocState("src/foo.codelore.md");
    expect(loaded?.sections.s1.blocks.changeGuide.staleSince).toBeUndefined();
    expect(loaded?.sections.s1.blocks.changeGuide.staleReason).toBeUndefined();
    expect(loaded?.sections.s1.blocks.changeGuide.staleFacets).toBeUndefined();
  });

  it("renderAndPersist keeps purpose rendered even when score is below minScore", async () => {
    const { storage, config } = await createStorage({ minScore: 0.9 });
    const state = makeAlwaysRenderState(0.1);

    await storage.renderAndPersist(state);

    expect(state.sections.s1.blocks.purpose.rendered).toBe(true);
    const md = await readFile(join(config.rootDir, state.docPath), "utf8");
    expect(md).toContain("Purpose body.");
  });

  it("renderAndPersist honours explicit perBlockScore override for always-render blocks", async () => {
    const { storage } = await createStorage({ minScore: 0.5, perBlockScore: { purpose: 0.9 } });
    const state = makeAlwaysRenderState(0.5);

    await storage.renderAndPersist(state);

    expect(state.sections.s1.blocks.purpose.rendered).toBe(false);
  });

  it("renderAndPersist recomputes block.rendered from scores and thresholds", async () => {
    const { storage, config } = await createStorage({ minScore: 0.7 });
    const state = makeSectionWithScoredBlock(0.5);

    await storage.renderAndPersist(state);

    expect(state.sections.s1.blocks.dependencies.rendered).toBe(false);
    const md = await readFile(join(config.rootDir, state.docPath), "utf8");
    expect(md).not.toContain("Body content.");
    expect(md.trim()).toBe("## Foo");
  });

  it("renderAndPersist revives filtered block when threshold is lowered", async () => {
    const { storage: tightStorage } = await createStorage({ minScore: 0.7 }, "shared-root");
    const state = makeSectionWithScoredBlock(0.5);
    await tightStorage.renderAndPersist(state);
    expect(state.sections.s1.blocks.dependencies.rendered).toBe(false);

    const { storage: looseStorage, config: looseConfig } = await reuseStorage(tightStorage, { minScore: 0.3 });
    const loaded = await looseStorage.loadDocState(state.docPath);
    expect(loaded).toBeDefined();
    if (!loaded) {
      return;
    }
    await looseStorage.renderAndPersist(loaded);

    expect(loaded.sections.s1.blocks.dependencies.rendered).toBe(true);
    const md = await readFile(join(looseConfig.rootDir, state.docPath), "utf8");
    expect(md).toContain("Body content.");
  });

  it("reconcileRenderedDocs re-persists only docs whose configFingerprint diverged", async () => {
    const { storage: tightStorage, config: tightConfig } = await createStorage({ minScore: 0.7 });
    const stateA = makeSectionWithScoredBlock(0.5, "src/a.codelore.md");
    const stateB = makeSectionWithScoredBlock(0.9, "src/b.codelore.md");
    await tightStorage.renderAndPersist(stateA);
    await tightStorage.renderAndPersist(stateB);

    // Reuse same root dir under a looser config
    const looseConfig = { ...tightConfig, thresholds: { ...tightConfig.thresholds, minScore: 0.3 } };
    const looseStorage = new DocStateStorage(looseConfig);

    const result = await looseStorage.reconcileRenderedDocs();
    expect(result.updated.sort()).toEqual(["src/a.codelore.md", "src/b.codelore.md"].sort());

    const second = await looseStorage.reconcileRenderedDocs();
    expect(second.updated).toEqual([]);

    const reloadedA = await looseStorage.loadDocState("src/a.codelore.md");
    expect(reloadedA?.sections.s1.blocks.dependencies.rendered).toBe(true);
  });

  it("renderAndPersist writes a translation .md and cleans up orphans when a language is removed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codelore-state-"));
    tempDirs.push(rootDir);
    await writeFile(
      join(rootDir, "codelore.config.json"),
      JSON.stringify({ docs: { language: "ru", translations: ["en"] } }),
      "utf8"
    );
    const config = loadConfig(rootDir);
    const storage = new DocStateStorage(config);

    const body = "Тело.";
    const state: DocState = {
      version: DOC_STATE_VERSION,
      docPath: "src/foo.codelore.md",
      generatedAt: "2026-05-20T00:00:00.000Z",
      sectionOrder: ["s1"],
      sections: {
        s1: {
          heading: "Foo",
          depth: 2,
          anchor: "foo",
          owns: [],
          depends: [],
          usedBy: [],
          status: "normal",
          allowedBlocks: ["purpose"],
          blockOrder: ["purpose"],
          blocks: {
            purpose: {
              body,
              rendered: true,
              language: "ru",
              translations: { en: { body: "Body.", sourceFingerprint: translationSourceFingerprint(body) } },
            },
          },
        },
      },
    };

    await storage.renderAndPersist(state);
    const enPath = join(rootDir, translationDocPath("src/foo.codelore.md", "en"));
    await expect(readFile(enPath, "utf8")).resolves.toContain("Body.");
    await expect(readFile(join(rootDir, "src/foo.codelore.md"), "utf8")).resolves.toContain("Тело.");

    // Drop the translation language: the orphan .md must be removed on next render.
    const noTranslations = new DocStateStorage(loadConfig(rootDir));
    (noTranslations as unknown as { config: CodeloreConfig }).config.docs.translations = [];
    await noTranslations.renderAndPersist(state);
    await expect(readFile(enPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renderAndPersist links a mention of a dependency documented in another doc", async () => {
    const { storage, config } = await createStorage();
    await storage.renderAndPersist(makeLinkedDepState());
    await storage.renderAndPersist(makeLinkedConsumerState());

    const md = await readFile(join(config.rootDir, "src/consumer.codelore.md"), "utf8");
    expect(md).toContain("Calls [`depFn`](dep.codelore.md#depfn).");
  });

  it("reconcileRenderedDocs rewrites a doc's .md when a link target appears later, without touching state", async () => {
    const { storage, config } = await createStorage();
    const consumer = makeLinkedConsumerState();
    await storage.renderAndPersist(consumer);
    const before = await readFile(join(config.rootDir, "src/consumer.codelore.md"), "utf8");
    expect(before).toContain("Calls `depFn`.");

    await storage.renderAndPersist(makeLinkedDepState());
    const { updated } = await storage.reconcileRenderedDocs();
    expect(updated).toEqual([]);

    const after = await readFile(join(config.rootDir, "src/consumer.codelore.md"), "utf8");
    expect(after).toContain("Calls [`depFn`](dep.codelore.md#depfn).");
    const reloaded = await storage.loadDocState("src/consumer.codelore.md");
    expect(reloaded?.sections.s1.blocks.purpose.body).toBe("Calls `depFn`.");
  });

  it("computeConfigFingerprint is stable across runs and ignores key order", async () => {
    const { config } = await createStorage();
    const a = computeConfigFingerprint(config);
    const b = computeConfigFingerprint({
      ...config,
      thresholds: { ...config.thresholds },
      docs: { ...config.docs, blockHeadings: { ...config.docs.blockHeadings } },
    });
    expect(a).toBe(b);
  });
});

function makeSectionWithScoredBlock(score: number, docPath = "src/foo.codelore.md"): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath,
    generatedAt: "2026-05-20T00:00:00.000Z",
    sectionOrder: ["s1"],
    sections: {
      s1: {
        heading: "Foo",
        depth: 2,
        anchor: "foo",
        owns: [],
        depends: [],
        usedBy: [],
        status: "normal",
        allowedBlocks: ["dependencies"],
        blockOrder: ["dependencies"],
        blocks: {
          dependencies: {
            body: "Body content.",
            rendered: true,
            scores: { informativeness: score, novelty: score, specificity: score, novelFact: "nf" },
          },
        },
      },
    },
  };
}

async function reuseStorage(
  prior: DocStateStorage,
  thresholdsOverride: { minScore: number }
): Promise<{ storage: DocStateStorage; config: CodeloreConfig }> {
  const rootDir = (prior as unknown as { config: CodeloreConfig }).config.rootDir;
  const config = loadConfig(rootDir);
  const merged: CodeloreConfig = {
    ...config,
    thresholds: { ...config.thresholds, minScore: thresholdsOverride.minScore },
  };
  return { storage: new DocStateStorage(merged), config: merged };
}

async function createStorage(
  thresholds?: { minScore?: number; perBlockScore?: Record<string, number> },
  _label?: string
): Promise<{ storage: DocStateStorage; config: CodeloreConfig }> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-state-"));
  tempDirs.push(rootDir);
  const configJson = thresholds
    ? JSON.stringify({
        thresholds: {
          minScore: thresholds.minScore ?? 0.6,
          ...(thresholds.perBlockScore ? { perBlockScore: thresholds.perBlockScore } : {}),
        },
      })
    : "{}";
  await writeFile(join(rootDir, "codelore.config.json"), configJson, "utf8");
  const config = loadConfig(rootDir);
  return { storage: new DocStateStorage(config), config };
}

function makeAlwaysRenderState(score: number, docPath = "src/foo.codelore.md"): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath,
    generatedAt: "2026-05-20T00:00:00.000Z",
    sectionOrder: ["s1"],
    sections: {
      s1: {
        heading: "Foo",
        depth: 2,
        anchor: "foo",
        owns: [],
        depends: [],
        usedBy: [],
        status: "normal",
        allowedBlocks: ["purpose"],
        blockOrder: ["purpose"],
        blocks: {
          purpose: {
            body: "Purpose body.",
            rendered: true,
            scores: { informativeness: score, novelty: score, specificity: score, novelFact: "nf" },
          },
        },
      },
    },
  };
}

function makeLinkedDepState(): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath: "src/dep.codelore.md",
    generatedAt: "2026-07-07T00:00:00.000Z",
    sectionOrder: ["symbol:src/dep.ts#depFn"],
    sections: {
      "symbol:src/dep.ts#depFn": {
        heading: "depFn",
        depth: 1,
        anchor: "depfn",
        owns: ["symbol:src/dep.ts#depFn"],
        depends: [],
        usedBy: [],
        status: "normal",
        allowedBlocks: ["purpose"],
        blockOrder: ["purpose"],
        blocks: { purpose: { body: "Dep body.", rendered: true } },
      },
    },
  };
}

function makeLinkedConsumerState(): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath: "src/consumer.codelore.md",
    generatedAt: "2026-07-07T00:00:00.000Z",
    sectionOrder: ["s1"],
    sections: {
      s1: {
        heading: "consumer",
        depth: 1,
        anchor: "consumer",
        owns: ["symbol:src/consumer.ts#consumer"],
        depends: ["symbol:src/dep.ts#depFn"],
        usedBy: [],
        status: "normal",
        allowedBlocks: ["purpose"],
        blockOrder: ["purpose"],
        blocks: { purpose: { body: "Calls `depFn`.", rendered: true } },
      },
    },
  };
}

function makeMinimalState(docPath: string): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath,
    generatedAt: "2026-05-20T00:00:00.000Z",
    sectionOrder: [],
    sections: {},
  };
}
