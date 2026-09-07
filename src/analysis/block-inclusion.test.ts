import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNIFICANT_GLOBALS, DEFAULT_STDLIB_PREFIXES } from "../config.js";
import type {
  CodeEntity,
  CodeloreConfig,
  EntityDocumentationDecision,
  EntityImportSpecifier,
  EntityMetrics,
} from "../types.js";
import { determineBlockInclusion } from "./block-inclusion.js";

const baseConfig: CodeloreConfig = {
  rootDir: "/tmp/x",
  sourceGlobs: [],
  docGlobs: [],
  excludeGlobs: [],
  indexDir: ".codelore",
  docs: {
    translations: [],
    writingRules: [],
    terms: [],
    blockHeadings: {
      purpose: "P",
      responsibility: "R",
      invariants: "I",
      dependencies: "D",
      workflows: "W",
      limitations: "L",
      changeGuide: "C",
    },
    blockHeadingsByLanguage: {},
  },
  thresholds: { weightMinimal: 1, weightFull: 3, minScore: 0.6, classFieldOverlap: 0.5 },
  blockInclusion: {
    enabled: true,
    stdlibPrefixes: DEFAULT_STDLIB_PREFIXES,
    significantGlobals: DEFAULT_SIGNIFICANT_GLOBALS,
  },
  llm: { provider: "test", providers: {}, concurrency: 5, verifyTypeContext: true },
};

function makeEntity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return {
    id: "symbol:src/x.ts#X",
    type: "function",
    path: "src/x.ts",
    name: "X",
    signature: "X()",
    range: { startOffset: 0, endOffset: 0, startLine: 1, endLine: 1 },
    directDeps: [],
    directUsages: [],
    contentHash: "abc",
    facets: { signature: "X()", body: "body", deps: "", usage: "", placement: "src/x.ts" },
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<EntityMetrics> = {}): EntityMetrics {
  return {
    statementCount: 1,
    inDegree: 0,
    hasSideEffects: false,
    isEntryPoint: false,
    imports: { specifiers: [] },
    globals: { used: [] },
    ...overrides,
  };
}

function makeDecision(role: EntityDocumentationDecision["role"]): EntityDocumentationDecision {
  return { weight: 1, role };
}

function specifier(overrides: Partial<EntityImportSpecifier> = {}): EntityImportSpecifier {
  return {
    localName: "x",
    importedName: "x",
    moduleSpecifier: "x",
    isTypeOnly: false,
    isStdlib: false,
    isExternal: true,
    isReferenced: true,
    ...overrides,
  };
}

describe("determineBlockInclusion", () => {
  describe("dependencies", () => {
    it("drops when only stdlib runtime imports and no internal deps", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({
          imports: {
            specifiers: [
              specifier({
                moduleSpecifier: "node:fs/promises",
                isStdlib: true,
                localName: "readFile",
                importedName: "readFile",
              }),
            ],
          },
        }),
        makeDecision("full_page"),
        baseConfig
      );

      expect(result.allowedBlocks).not.toContain("dependencies");
      expect(result.skipped.find((entry) => entry.blockId === "dependencies")?.reason).toMatch(/stdlib or type-only/);
    });

    it("drops when all referenced imports are type-only", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({
          imports: {
            specifiers: [specifier({ moduleSpecifier: "./helper", isExternal: false, isTypeOnly: true })],
          },
        }),
        makeDecision("short_page"),
        baseConfig
      );

      expect(result.allowedBlocks).not.toContain("dependencies");
    });

    it("keeps when mixed import has at least one referenced non-type-only runtime specifier", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({
          imports: {
            specifiers: [
              specifier({
                localName: "Foo",
                importedName: "Foo",
                isTypeOnly: true,
                moduleSpecifier: "./mod",
                isExternal: false,
              }),
              specifier({
                localName: "runtimeBar",
                importedName: "runtimeBar",
                isTypeOnly: false,
                moduleSpecifier: "./mod",
                isExternal: false,
              }),
            ],
          },
        }),
        makeDecision("short_page"),
        baseConfig
      );

      expect(result.allowedBlocks).toContain("dependencies");
    });

    it("keeps when only stdlib but a significant global is used", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({
          imports: { specifiers: [specifier({ moduleSpecifier: "node:fs", isStdlib: true })] },
          globals: { used: [{ name: "process", access: "process.env.NODE_ENV" }] },
        }),
        makeDecision("short_page"),
        baseConfig
      );

      expect(result.allowedBlocks).toContain("dependencies");
    });

    it("keeps when external non-stdlib runtime import is referenced", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({
          imports: {
            specifiers: [specifier({ moduleSpecifier: "fast-glob", isStdlib: false, isExternal: true })],
          },
        }),
        makeDecision("short_page"),
        baseConfig
      );

      expect(result.allowedBlocks).toContain("dependencies");
    });

    it("keeps when entity has internal directDeps even without imports", () => {
      const result = determineBlockInclusion(
        makeEntity({ directDeps: ["symbol:src/other.ts#Helper"] }),
        makeMetrics(),
        makeDecision("short_page"),
        baseConfig
      );

      expect(result.allowedBlocks).toContain("dependencies");
    });

    it("ignores unreferenced imports", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({
          imports: {
            specifiers: [specifier({ moduleSpecifier: "fast-glob", isReferenced: false })],
          },
        }),
        makeDecision("short_page"),
        baseConfig
      );

      expect(result.allowedBlocks).not.toContain("dependencies");
    });
  });

  describe("workflows", () => {
    it("drops when inDegree=0 and not entry point", () => {
      const result = determineBlockInclusion(makeEntity(), makeMetrics(), makeDecision("short_page"), baseConfig);
      expect(result.allowedBlocks).not.toContain("workflows");
    });

    it("keeps when inDegree > 0", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({ inDegree: 2 }),
        makeDecision("short_page"),
        baseConfig
      );
      expect(result.allowedBlocks).toContain("workflows");
    });

    it("keeps when entry point even with inDegree=0", () => {
      const result = determineBlockInclusion(
        makeEntity(),
        makeMetrics({ inDegree: 0, isEntryPoint: true }),
        makeDecision("short_page"),
        baseConfig
      );
      expect(result.allowedBlocks).toContain("workflows");
    });
  });

  describe("changeGuide", () => {
    it("drops for short_page", () => {
      const result = determineBlockInclusion(makeEntity(), makeMetrics(), makeDecision("short_page"), baseConfig);
      expect(result.allowedBlocks).not.toContain("changeGuide");
    });

    it("drops for one_line", () => {
      const result = determineBlockInclusion(makeEntity(), makeMetrics(), makeDecision("one_line"), baseConfig);
      expect(result.allowedBlocks).not.toContain("changeGuide");
    });

    it("keeps for full_page", () => {
      const result = determineBlockInclusion(makeEntity(), makeMetrics(), makeDecision("full_page"), baseConfig);
      expect(result.allowedBlocks).toContain("changeGuide");
    });
  });

  describe("always-on blocks", () => {
    it("always includes purpose, responsibility, invariants, limitations", () => {
      const result = determineBlockInclusion(makeEntity(), makeMetrics(), makeDecision("one_line"), baseConfig);
      expect(result.allowedBlocks).toEqual(
        expect.arrayContaining(["purpose", "responsibility", "invariants", "limitations"])
      );
    });
  });

  describe("enabled=false fallback", () => {
    it("returns all 7 blocks with no skipped entries", () => {
      const result = determineBlockInclusion(makeEntity(), makeMetrics(), makeDecision("one_line"), {
        ...baseConfig,
        blockInclusion: { ...baseConfig.blockInclusion, enabled: false },
      });

      expect(result.allowedBlocks).toEqual([
        "purpose",
        "responsibility",
        "invariants",
        "dependencies",
        "workflows",
        "limitations",
        "changeGuide",
      ]);
      expect(result.skipped).toEqual([]);
    });
  });

  it("preserves BLOCK_IDS ordering in allowedBlocks", () => {
    const result = determineBlockInclusion(
      makeEntity({ directDeps: ["x"] }),
      makeMetrics({ inDegree: 1 }),
      makeDecision("full_page"),
      baseConfig
    );

    expect(result.allowedBlocks).toEqual([
      "purpose",
      "responsibility",
      "invariants",
      "dependencies",
      "workflows",
      "limitations",
      "changeGuide",
    ]);
  });
});
