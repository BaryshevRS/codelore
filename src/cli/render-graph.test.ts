import { describe, expect, it } from "vitest";
import type { CodeEntity, DocSection, ProjectIndex } from "../types.js";
import { renderGraphHtml, renderGraphTree } from "./render-graph.js";

function entity(file: string, deps: string[], role?: "full_page" | "none"): CodeEntity {
  return {
    id: `symbol:${file}#fn`,
    type: "function",
    path: file,
    name: "fn",
    signature: "fn()",
    range: { startOffset: 0, endOffset: 10, startLine: 1, endLine: 1 },
    directDeps: deps.map((dep) => `symbol:${dep}#fn`),
    directUsages: [],
    contentHash: "hash",
    facets: { signature: "s", body: "b", deps: "d", usage: "u", placement: "p" },
    ...(role ? { metadata: { role } as never } : {}),
  };
}

function docSection(file: string, stale: boolean): DocSection {
  return {
    id: `symbol:${file}#fn`,
    docPath: file.replace(".ts", ".codelore.md"),
    heading: "fn",
    depth: 1,
    anchor: "fn",
    owns: [`symbol:${file}#fn`],
    depends: [],
    usedBy: [],
    status: "normal",
    blockFingerprints: {},
    allowedBlocks: ["purpose"],
    blocks: [
      {
        id: "purpose",
        heading: "Purpose",
        depth: 2,
        body: "text",
        rendered: true,
        ...(stale ? { staleSince: "2026-06-10T00:00:00.000Z" } : {}),
      },
    ],
  };
}

function projectIndex(): ProjectIndex {
  const entities = [
    entity("src/app.ts", ["src/util.ts"]),
    entity("src/util.ts", []),
    entity("src/lone.ts", []),
    entity("src/types.ts", [], "none"),
  ];
  const sections = [docSection("src/util.ts", false), docSection("src/app.ts", true)];
  return {
    version: 1,
    generatedAt: "",
    code: {
      version: 1,
      generatedAt: "",
      rootDir: "/r",
      entities: Object.fromEntries(entities.map((e) => [e.id, e])),
      fileToEntities: Object.fromEntries(entities.map((e) => [e.path, [e.id]])),
    },
    docs: {
      version: 1,
      generatedAt: "",
      rootDir: "/r",
      sections: Object.fromEntries(sections.map((s) => [s.id, s])),
      fileToSections: {},
      entityToSections: {},
    },
  };
}

describe("renderGraphTree", () => {
  it("renders waves with doc status and dependency arrows", () => {
    const text = renderGraphTree({ index: projectIndex() });
    expect(text).toContain("wave 0");
    expect(text).toContain("wave 1");
    expect(text).toContain("✓ src/util.ts (1 section)");
    expect(text).toContain("~ src/app.ts (1 section, 1 stale)");
    expect(text).toContain("! src/lone.ts");
    expect(text).toContain("∅ src/types.ts");
    expect(text).toContain("← ✓ src/util.ts");
  });

  it("keeps out-of-scope dependencies visible for scoped files", () => {
    const text = renderGraphTree({ index: projectIndex(), paths: ["src/app.ts"] });
    expect(text).toContain("src/app.ts");
    expect(text).toContain("src/util.ts");
    expect(text).not.toContain("src/lone.ts");
  });
});

describe("renderGraphHtml", () => {
  it("renders a self-contained Cytoscape page with nodes, statuses, and edges", () => {
    const html = renderGraphHtml({ index: projectIndex() });
    expect(html).toContain("cytoscape.min.js");
    const payload = JSON.parse(html.match(/const data = (\{.*?\});\n/s)?.[1] ?? "{}");
    const byId = Object.fromEntries(payload.nodes.map((n: { data: { id: string } }) => [n.data.id, n.data]));
    expect(byId["src/util.ts"]).toMatchObject({ status: "documented", sections: 1, wave: 0 });
    expect(byId["src/app.ts"]).toMatchObject({ status: "stale", staleSections: 1, wave: 1 });
    expect(byId["src/lone.ts"]).toMatchObject({ status: "pending" });
    expect(byId["src/types.ts"]).toMatchObject({ status: "excluded" });
    expect(payload.edges).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ source: "src/app.ts", target: "src/util.ts" }) }),
    ]);
    // app sits above util in the pyramid (lower y = higher wave).
    const pos = Object.fromEntries(
      payload.nodes
        .filter((n: { position?: unknown }) => n.position)
        .map((n: { data: { id: string }; position: { y: number } }) => [n.data.id, n.position])
    );
    expect(pos["src/app.ts"].y).toBeLessThan(pos["src/util.ts"].y);
  });
});
