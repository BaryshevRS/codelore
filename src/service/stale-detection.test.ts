import { describe, expect, it } from "vitest";
import type { DocBlock, DocSection } from "../types.js";
import { collectLanguageStaleBlocks } from "./stale-detection.js";

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
