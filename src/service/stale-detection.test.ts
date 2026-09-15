import { describe, expect, it } from "vitest";
import { computeBlockFingerprint } from "../markdown/block-facets.js";
import type { BlockId } from "../markdown/block-ids.js";
import type { CodeEntity, DocBlock, DocSection } from "../types.js";
import { collectLanguageStaleBlocks, collectUnwrittenBlocks, narrowTargetBlocks } from "./stale-detection.js";

function block(overrides: Partial<DocBlock> = {}): DocBlock {
  return { id: "purpose", heading: "Purpose", depth: 3, body: "Body.", rendered: true, ...overrides };
}

function section(blocks: DocBlock[]): DocSection {
  return {
    id: "s1",
    docPath: "src/x.codelore.md",
    heading: "X",
    depth: 2,
    anchor: "x",
    owns: [],
    depends: [],
    usedBy: [],
    blocks,
    status: "normal",
    blockFingerprints: {},
    allowedBlocks: ["purpose"],
  };
}

describe("collectLanguageStaleBlocks", () => {
  it("flags a block stamped with a language other than the canonical one", () => {
    const stale = collectLanguageStaleBlocks([section([block({ language: "ru" })])], "en");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ blockId: "purpose", changedFacets: ["language"], drift: "facet_changed" });
  });

  it("ignores a block written in the canonical language", () => {
    expect(collectLanguageStaleBlocks([section([block({ language: "en" })])], "en")).toHaveLength(0);
  });

  it("ignores a block with no language stamp (cannot prove drift)", () => {
    expect(collectLanguageStaleBlocks([section([block({ language: undefined })])], "en")).toHaveLength(0);
  });

  it("ignores already-stale and empty blocks", () => {
    const blocks = [
      block({ language: "ru", staleSince: "2026-01-01T00:00:00.000Z" }),
      block({ language: "ru", body: "  " }),
    ];
    expect(collectLanguageStaleBlocks([section(blocks)], "en")).toHaveLength(0);
  });

  it("does nothing when no canonical language is configured", () => {
    expect(collectLanguageStaleBlocks([section([block({ language: "ru" })])], undefined)).toHaveLength(0);
  });
});

function ownedEntity(): CodeEntity {
  return {
    id: "symbol:src/x.ts#fn",
    type: "function",
    path: "src/x.ts",
    name: "fn",
    signature: "fn(): void",
    range: { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 },
    directDeps: [],
    directUsages: [],
    contentHash: "h",
    facets: { signature: "s", body: "b", deps: "d", usage: "u", placement: "p" },
  };
}

describe("collectUnwrittenBlocks", () => {
  const entities = { "symbol:src/x.ts#fn": ownedEntity() };
  const current = computeBlockFingerprint("purpose", ["symbol:src/x.ts#fn"], entities);

  function owned(blocks: DocBlock[], fingerprints: Record<string, string>): DocSection {
    return { ...section(blocks), owns: ["symbol:src/x.ts#fn"], blockFingerprints: fingerprints };
  }

  it("queues an empty block whose code moved on since the skeleton was stamped", () => {
    const found = collectUnwrittenBlocks([owned([block({ body: "" })], { purpose: "old-fingerprint" })], entities);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ blockId: "purpose", drift: "facet_changed" });
  });

  it("ignores an empty block still matching the code: nothing changed to ask about", () => {
    const fingerprints: Record<string, string> = current === undefined ? {} : { purpose: current };
    expect(collectUnwrittenBlocks([owned([block({ body: "" })], fingerprints)], entities)).toHaveLength(0);
  });

  it("ignores a block that has text: that is ordinary staleness, handled elsewhere", () => {
    expect(collectUnwrittenBlocks([owned([block({ body: "Text." })], { purpose: "old" })], entities)).toHaveLength(0);
  });

  it("ignores a tombstoned block: it is already queued as tombstoned", () => {
    const blocks = [block({ body: "", staleSince: "2026-01-01T00:00:00.000Z" })];
    expect(collectUnwrittenBlocks([owned(blocks, { purpose: "old" })], entities)).toHaveLength(0);
  });

  it("ignores a section whose owning entity is gone", () => {
    expect(collectUnwrittenBlocks([owned([block({ body: "" })], { purpose: "old" })], {})).toHaveLength(0);
  });
});

describe("narrowTargetBlocks", () => {
  it("intersects existing targets, fills sections that had none, and drops sections left empty", () => {
    const existing = new Map<string, BlockId[]>([
      ["kept", ["purpose", "workflows"]],
      ["emptied", ["workflows"]],
    ]);

    const narrowed = narrowTargetBlocks(existing, ["kept", "emptied", "forced"], ["purpose", "responsibility"]);

    expect(narrowed.get("kept")).toEqual(["purpose"]);
    expect(narrowed.has("emptied")).toBe(false);
    expect(narrowed.get("forced")).toEqual(["purpose", "responsibility"]);
  });
});
