import { describe, expect, it } from "vitest";
import type { CodeEntity, CodeIndex, DocState, DocStateBlock, DocStateSection } from "../types.js";
import { renderArchitecture } from "./render-architecture.js";

function makeBlock(body: string, overrides: Partial<DocStateBlock> = {}): DocStateBlock {
  return { body, rendered: true, ...overrides };
}

function makeSection(overrides: Partial<DocStateSection> = {}): DocStateSection {
  return {
    heading: "Section",
    depth: 1,
    anchor: "section",
    owns: [],
    depends: [],
    usedBy: [],
    status: "normal",
    allowedBlocks: ["purpose"],
    blockOrder: ["purpose"],
    blocks: {},
    ...overrides,
  };
}

function makeState(docPath: string, sectionId: string, section: DocStateSection): DocState {
  return {
    version: 4,
    docPath,
    generatedAt: "2026-09-01T00:00:00.000Z",
    sectionOrder: [sectionId],
    sections: { [sectionId]: section },
  };
}

function projectState(blocks: Record<string, DocStateBlock>, domainIds: string[] = []): DocState {
  return makeState(
    "overview.codelore.md",
    "project:",
    makeSection({ heading: "Overview", anchor: "overview", owns: ["project:"], depends: domainIds, blocks })
  );
}

function domainState(slug: string, overrides: Partial<DocStateSection> = {}): DocState {
  return makeState(
    `docs/domains/${slug}.codelore.md`,
    `domain:${slug}`,
    makeSection({ heading: slug, anchor: slug, owns: [`domain:${slug}`], ...overrides })
  );
}

function fileState(path: string): DocState {
  return makeState(
    `${path.replace(/\.ts$/, "")}.codelore.md`,
    `file:${path}`,
    makeSection({ heading: path, anchor: path, owns: [`file:${path}`] })
  );
}

function codeIndex(files: string[], entryPoints: string[] = []): CodeIndex {
  const entities: Record<string, CodeEntity> = {};
  for (const path of entryPoints) {
    entities[`file:${path}`] = {
      id: `file:${path}`,
      type: "file",
      path,
      name: path,
      signature: path,
      range: { startOffset: 0, endOffset: 0, startLine: 1, endLine: 1 },
      directDeps: [],
      directUsages: [],
      contentHash: "hash",
      facets: { signature: "", body: "", deps: "", usage: "", placement: "" },
      metadata: {
        statementCount: 1,
        inDegree: 0,
        hasSideEffects: true,
        isEntryPoint: true,
        imports: { specifiers: [] },
        globals: { used: [] },
        weight: 1,
        role: "short_page",
        allowedBlocks: [],
        skippedBlocks: [],
      },
    };
  }
  return {
    version: 2,
    generatedAt: "2026-09-01T00:00:00.000Z",
    rootDir: "/repo",
    entities,
    fileToEntities: Object.fromEntries(files.map((file) => [file, []])),
  };
}

describe("renderArchitecture", () => {
  it("lays out the page as overview, boundaries, entry points, code map, coverage", () => {
    const markdown = renderArchitecture({
      states: [
        projectState({
          purpose: makeBlock("What it is."),
          responsibility: makeBlock("What it owns."),
          workflows: makeBlock("How a run flows."),
          limitations: makeBlock("What it never does."),
        }),
        domainState("storage", { depends: ["file:src/store.ts"] }),
      ],
      code: codeIndex(["src/store.ts", "src/bin/tool.ts"], ["src/bin/tool.ts"]),
    });

    expect(markdown.match(/^## .*/gm)).toEqual([
      "## Bird's eye view",
      "## What the system does not do",
      "## Entry points",
      "## Code map",
      "## Coverage",
    ]);
    expect(markdown).toContain("What it is.\n\nWhat it owns.\n\nHow a run flows.");
    expect(markdown).toContain("What it never does.");
  });

  it("withholds a stale or filtered block instead of copying it onto the page", () => {
    const markdown = renderArchitecture({
      states: [
        projectState({
          purpose: makeBlock("Fresh purpose."),
          responsibility: makeBlock("Stale claim.", { staleSince: "2026-09-01T00:00:00.000Z" }),
          workflows: makeBlock("Filtered out.", { rendered: false }),
        }),
        domainState("storage", {
          blocks: {
            purpose: makeBlock("Domain purpose."),
            responsibility: makeBlock("Stale domain claim.", { staleSince: "2026-09-01T00:00:00.000Z" }),
          },
        }),
      ],
      code: codeIndex([]),
    });

    expect(markdown).toContain("Fresh purpose.");
    expect(markdown).not.toContain("Stale claim.");
    expect(markdown).not.toContain("Filtered out.");
    // The domain falls back to its purpose rather than losing its description.
    expect(markdown).toContain("Domain purpose.");
    expect(markdown).not.toContain("Stale domain claim.");
  });

  it("orders subsystems so each stands on the ones before it, and links their files", () => {
    const markdown = renderArchitecture({
      states: [
        projectState({}),
        domainState("service", { depends: ["domain:storage", "file:src/service.ts"] }),
        domainState("storage", { depends: ["file:src/store.ts"] }),
        fileState("src/store.ts"),
      ],
      code: codeIndex(["src/service.ts", "src/store.ts"]),
    });

    expect(markdown).toContain("1. storage\n2. service");
    expect(markdown.indexOf("### [storage]")).toBeLessThan(markdown.indexOf("### [service]"));
    expect(markdown).toContain("[`src/store.ts`](src/store.codelore.md)");
    // An undocumented member is named, not linked.
    expect(markdown).toContain("\n`src/service.ts`\n");
  });

  it("names the command an entry point ships as, and stays silent when two bins match", () => {
    const states = [projectState({}), domainState("cli", { depends: ["file:src/cli.ts"] })];
    const code = codeIndex(["src/cli.ts", "src/bin/tool.ts"], ["src/bin/tool.ts"]);

    expect(renderArchitecture({ states, code, bin: { tool: "./dist/bin/tool.js" } })).toContain(
      "- `src/bin/tool.ts` — `tool`"
    );
    const ambiguous = renderArchitecture({
      states,
      code,
      bin: { tool: "./dist/bin/tool.js", "tool-mcp": "./dist/server/tool.js" },
    });
    expect(ambiguous).toContain("- `src/bin/tool.ts`\n");
    expect(ambiguous).not.toContain("— `tool`");
  });

  it("counts the files the map names and lists the ones it leaves out", () => {
    const markdown = renderArchitecture({
      states: [projectState({}), domainState("storage", { depends: ["file:src/store.ts"] })],
      code: codeIndex(["src/store.ts", "src/types.ts"]),
    });

    expect(markdown).toContain("The map covers 1 of 2 source files.");
    expect(markdown).toContain("Outside the map:\n- `src/types.ts`");
  });
});
