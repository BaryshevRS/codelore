import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { CodeloreService } from "../service/codelore-service.js";
import { DocStateStorage } from "../storage/doc-state-storage.js";
import type { GeneratedBlock } from "../types.js";
import { buildDocIndex, patchDocIndexPaths } from "./state-indexer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function generatedBlock(text: string): GeneratedBlock {
  return { text, novelFact: text, informativeness: 0.8, novelty: 0.8, specificity: 0.8 };
}

const DOC_PATH = "src/pricing.codelore.md";
const FILE = "file:src/pricing.ts";
const ROUND = "symbol:src/pricing.ts#roundPrice";
const BUILD = "symbol:src/pricing.ts#buildPrice";

/** Two-entity doc: the module section plus two sections, each owning its own entity. */
async function twoSectionProject(): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  storage: DocStateStorage;
}> {
  const rootDir = await makeTempProject({
    "src/pricing.ts": [
      "export function roundPrice(value: number): number { return Math.round(value); }",
      "export function buildPrice(amount: number): number { return roundPrice(amount); }",
    ].join("\n"),
  });
  const service = new CodeloreService(rootDir);
  await service.prepareInitialDocs();
  await service.rewriteSection(ROUND, { generatedBlocks: { purpose: generatedBlock("Rounds the price.") } });
  await service.rewriteSection(BUILD, { generatedBlocks: { purpose: generatedBlock("Builds the price.") } });
  const config = await loadConfig(rootDir);
  return { config, storage: new DocStateStorage(config) };
}

describe("patchDocIndexPaths", () => {
  it("removes a section dropped from doc state across sections, fileToSections, and entityToSections", async () => {
    const { config, storage } = await twoSectionProject();
    const index = await buildDocIndex(config, storage);

    expect(index.fileToSections[DOC_PATH]).toEqual([FILE, ROUND, BUILD]);
    expect(index.entityToSections[ROUND]).toEqual([ROUND]);
    expect(index.sections[ROUND]).toBeDefined();

    // Drop roundPrice's section from the doc state (as if its entity disappeared).
    const state = await storage.loadDocState(DOC_PATH);
    if (!state) {
      throw new Error("missing doc state");
    }
    state.sectionOrder = state.sectionOrder.filter((id) => id !== ROUND);
    delete state.sections[ROUND];
    await storage.saveDocState(state);

    await patchDocIndexPaths(index, config, storage, [DOC_PATH]);

    expect(index.sections[ROUND]).toBeUndefined();
    expect(index.fileToSections[DOC_PATH]).toEqual([FILE, BUILD]);
    expect(index.entityToSections[ROUND]).toBeUndefined();
    // The surviving section is untouched.
    expect(index.sections[BUILD]).toBeDefined();
    expect(index.entityToSections[BUILD]).toEqual([BUILD]);
  });

  it("remaps entityToSections when a section's owns changes", async () => {
    const { config, storage } = await twoSectionProject();
    const index = await buildDocIndex(config, storage);
    expect(index.entityToSections[ROUND]).toEqual([ROUND]);

    const Renamed = "symbol:src/pricing.ts#roundPriceV2";
    const state = await storage.loadDocState(DOC_PATH);
    if (!state) {
      throw new Error("missing doc state");
    }
    state.sections[ROUND].owns = [Renamed];
    await storage.saveDocState(state);

    await patchDocIndexPaths(index, config, storage, [DOC_PATH]);

    // Old owner mapping is gone; new owner points at the section.
    expect(index.entityToSections[ROUND]).toBeUndefined();
    expect(index.entityToSections[Renamed]).toEqual([ROUND]);
    expect(index.sections[ROUND]?.owns).toEqual([Renamed]);
  });

  it("drops a doc path entirely when its state no longer exists", async () => {
    const { config, storage } = await twoSectionProject();
    const index = await buildDocIndex(config, storage);
    expect(index.fileToSections[DOC_PATH]).toBeDefined();

    await storage.deleteDocState(DOC_PATH);
    await patchDocIndexPaths(index, config, storage, [DOC_PATH]);

    expect(index.fileToSections[DOC_PATH]).toBeUndefined();
    expect(index.sections[ROUND]).toBeUndefined();
    expect(index.sections[BUILD]).toBeUndefined();
    expect(index.entityToSections[ROUND]).toBeUndefined();
    expect(index.entityToSections[BUILD]).toBeUndefined();
  });
});

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-stateindex-"));
  tempDirs.push(rootDir);
  for (const [path, text] of Object.entries(files)) {
    const absolutePath = join(rootDir, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }
  return rootDir;
}
