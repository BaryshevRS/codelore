import { describe, expect, it } from "vitest";
import type { CodeloreConfig, DocState, DocStateBlock, DocStateSection } from "../types.js";
import { translationSourceFingerprint } from "./block-facets.js";
import { resolveBlockHeadings } from "./locales.js";
import { renderDoc } from "./render-doc.js";

const baseConfig: CodeloreConfig = {
  rootDir: "/tmp/root",
  sourceGlobs: [],
  docGlobs: [],
  excludeGlobs: [],
  indexDir: ".codelore",
  docs: {
    translations: [],
    writingRules: [],
    terms: [],
    blockHeadings: resolveBlockHeadings(undefined),
    blockHeadingsByLanguage: {},
  },
  thresholds: { weightMinimal: 1, weightFull: 3, minScore: 0.6, classFieldOverlap: 0.5 },
  blockInclusion: { enabled: true, stdlibPrefixes: [], significantGlobals: [] },
  llm: { provider: "test", providers: {}, concurrency: 5, verifyTypeContext: true },
};

function makeBlock(body: string, overrides: Partial<DocStateBlock> = {}): DocStateBlock {
  return { body, rendered: true, ...overrides };
}

function makeSection(overrides: Partial<DocStateSection> = {}): DocStateSection {
  return {
    heading: "Section",
    depth: 2,
    anchor: "section",
    owns: [],
    depends: [],
    usedBy: [],
    status: "normal",
    allowedBlocks: ["purpose"],
    blockOrder: ["purpose"],
    blocks: { purpose: makeBlock("Section purpose.") },
    ...overrides,
  };
}

function makeState(sections: Record<string, DocStateSection>, order?: string[]): DocState {
  return {
    version: 3,
    docPath: "src/example.codelore.md",
    generatedAt: "2026-05-20T00:00:00.000Z",
    sectionOrder: order ?? Object.keys(sections),
    sections,
  };
}

describe("renderDoc", () => {
  it("returns empty string when there are no sections", () => {
    const state = makeState({}, []);
    expect(renderDoc(state, baseConfig)).toBe("");
  });

  it("renders a section with a single rendered block", () => {
    const state = makeState({ s1: makeSection({ heading: "Foo", anchor: "foo" }) });
    expect(renderDoc(state, baseConfig)).toBe(
      `## Foo

### Purpose

Section purpose.
`
    );
  });

  it("renders the section signature as a fenced code line under the heading", () => {
    const state = makeState({
      s1: makeSection({ heading: "buildFileDag", signature: "buildFileDag(code: CodeIndex): FileDag" }),
    });
    expect(renderDoc(state, baseConfig)).toBe(
      `## buildFileDag

\`\`\`ts
buildFileDag(code: CodeIndex): FileDag
\`\`\`

### Purpose

Section purpose.
`
    );
  });

  it("renders an empty section heading-only when no blocks rendered", () => {
    const state = makeState({
      s1: makeSection({
        heading: "Empty",
        blocks: { purpose: makeBlock("", { rendered: false }) },
      }),
    });
    expect(renderDoc(state, baseConfig)).toBe(`## Empty\n`);
  });

  it("skips blocks with rendered: false", () => {
    const state = makeState({
      s1: makeSection({
        allowedBlocks: ["purpose", "limitations"],
        blockOrder: ["purpose", "limitations"],
        blocks: {
          purpose: makeBlock("Visible."),
          limitations: makeBlock("Hidden.", { rendered: false }),
        },
      }),
    });
    expect(renderDoc(state, baseConfig)).toBe(
      `## Section

### Purpose

Visible.
`
    );
  });

  it("withholds the stale block body and collapses it into a summary banner", () => {
    const state = makeState({
      s1: makeSection({
        allowedBlocks: ["purpose", "limitations"],
        blockOrder: ["purpose", "limitations"],
        blocks: {
          purpose: makeBlock("Old body.", {
            staleSince: "2026-05-20T00:00:00.000Z",
            staleReason: "body_changed",
          }),
          limitations: makeBlock("Fresh body."),
        },
      }),
    });
    const rendered = renderDoc(state, baseConfig);
    expect(rendered).toBe(
      `## Section

> ⚠ Stale (body changed, since 2026-05-20T00:00:00.000Z): Purpose. Regenerate to refresh.

### Limitations and Tradeoffs

Fresh body.
`
    );
    expect(rendered).not.toContain("Old body.");
    expect(rendered).not.toContain("### Purpose");
  });

  it("collapses stale blocks sharing a reason into one summary line", () => {
    const state = makeState({
      s1: makeSection({
        allowedBlocks: ["purpose", "invariants", "limitations"],
        blockOrder: ["purpose", "invariants", "limitations"],
        blocks: {
          purpose: makeBlock("A", { staleSince: "2026-05-20T00:00:00.000Z", staleReason: "signature_changed" }),
          invariants: makeBlock("B", { staleSince: "2026-05-20T00:00:00.000Z", staleReason: "signature_changed" }),
          limitations: makeBlock("Fresh."),
        },
      }),
    });
    const rendered = renderDoc(state, baseConfig);
    expect(rendered).toContain(
      "> ⚠ Stale (signature changed, since 2026-05-20T00:00:00.000Z): Purpose, Invariants and Contract. Regenerate to refresh."
    );
    expect(rendered.match(/⚠ Stale/g)).toHaveLength(1);
  });

  it("renders multiple sections separated by blank lines in sectionOrder", () => {
    const state = makeState(
      {
        s1: makeSection({ heading: "First" }),
        s2: makeSection({ heading: "Second", blocks: { purpose: makeBlock("Second body.") } }),
      },
      ["s1", "s2"]
    );
    expect(renderDoc(state, baseConfig)).toBe(
      `## First

### Purpose

Section purpose.

## Second

### Purpose

Second body.
`
    );
  });

  it("respects blockOrder over BLOCK_IDS default", () => {
    const state = makeState({
      s1: makeSection({
        allowedBlocks: ["purpose", "limitations"],
        blockOrder: ["limitations", "purpose"],
        blocks: {
          purpose: makeBlock("Purpose body."),
          limitations: makeBlock("Limitations body."),
        },
      }),
    });
    expect(renderDoc(state, baseConfig)).toBe(
      `## Section

### Limitations and Tradeoffs

Limitations body.

### Purpose

Purpose body.
`
    );
  });
});

describe("renderDoc translations", () => {
  const enConfig: CodeloreConfig = {
    ...baseConfig,
    docs: {
      language: "ru",
      translations: ["en"],
      writingRules: [],
      terms: [],
      blockHeadings: resolveBlockHeadings("ru"),
      blockHeadingsByLanguage: { en: resolveBlockHeadings("en") },
    },
  };

  it("renders the translation body and the target-language heading", () => {
    const body = "Назначение модуля.";
    const state = makeState({
      s1: makeSection({
        heading: "Foo",
        blocks: {
          purpose: makeBlock(body, {
            translations: { en: { body: "Module purpose.", sourceFingerprint: translationSourceFingerprint(body) } },
          }),
        },
      }),
    });
    expect(renderDoc(state, enConfig, "en")).toBe(
      `## Foo

### Purpose

Module purpose.
`
    );
  });

  it("emits a pending callout when the translation is missing", () => {
    const state = makeState({ s1: makeSection({ heading: "Foo", blocks: { purpose: makeBlock("Тело.") } }) });
    const rendered = renderDoc(state, enConfig, "en");
    expect(rendered).toContain("> ⚠ Translation pending. Run update to refresh.");
    expect(rendered).not.toContain("Тело.");
  });

  it("emits a pending callout when the translation is stale against the canonical body", () => {
    const state = makeState({
      s1: makeSection({
        heading: "Foo",
        blocks: {
          purpose: makeBlock("Новое тело.", {
            translations: {
              en: { body: "Old translation.", sourceFingerprint: translationSourceFingerprint("Старое тело.") },
            },
          }),
        },
      }),
    });
    const rendered = renderDoc(state, enConfig, "en");
    expect(rendered).toContain("> ⚠ Translation pending. Run update to refresh.");
    expect(rendered).not.toContain("Old translation.");
  });

  it("localizes the stale callout in the canonical language", () => {
    const state = makeState({
      s1: makeSection({
        heading: "Foo",
        blocks: {
          purpose: makeBlock("Тело.", { staleSince: "2026-05-20T00:00:00.000Z", staleReason: "body_changed" }),
        },
      }),
    });
    expect(renderDoc(state, enConfig)).toContain(
      "> ⚠ Устарело (изменилось тело, с 2026-05-20T00:00:00.000Z): Зачем это нужно. Обновите документацию."
    );
  });
});
