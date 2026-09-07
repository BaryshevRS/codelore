import { describe, expect, it } from "vitest";
import type { CodeEntity, CodeIndex } from "../types.js";
import { buildDomainDag } from "./domain-dag.js";
import { dependencyWaves } from "./waves.js";

function indexFromDeps(deps: Record<string, string[]>): CodeIndex {
  const entities: Record<string, CodeEntity> = {};
  const fileToEntities: Record<string, string[]> = {};
  for (const [file, dependsOn] of Object.entries(deps)) {
    const id = `symbol:${file}#fn`;
    entities[id] = {
      id,
      type: "function",
      path: file,
      name: "fn",
      signature: "fn()",
      range: { startOffset: 0, endOffset: 10, startLine: 1, endLine: 1 },
      directDeps: dependsOn.map((dep) => `symbol:${dep}#fn`),
      directUsages: [],
      contentHash: "hash",
      facets: { signature: "s", body: "b", deps: "d", usage: "u", placement: "p" },
    };
    fileToEntities[file] = [id];
  }
  return { version: 1, generatedAt: "", rootDir: "/r", entities, fileToEntities };
}

describe("buildDomainDag", () => {
  it("collapses file edges to domain edges by map membership, dropping intra-domain deps", () => {
    const code = indexFromDeps({
      "a/svc.ts": ["b/writer.ts", "a/helper.ts"],
      "a/helper.ts": [],
      "b/writer.ts": ["c/dag.ts"],
      "c/dag.ts": [],
    });
    // Membership cuts across directories: svc+writer in one domain, helper+dag in another.
    const fileToDomain = new Map([
      ["a/svc.ts", "core"],
      ["b/writer.ts", "core"],
      ["a/helper.ts", "util"],
      ["c/dag.ts", "util"],
    ]);
    const dag = buildDomainDag(code, fileToDomain);
    expect([...(dag.get("core") ?? [])].sort()).toEqual(["util"]);
    expect([...(dag.get("util") ?? [])]).toEqual([]);
  });

  it("ignores files with no domain assignment", () => {
    const code = indexFromDeps({ "a/x.ts": ["b/y.ts"], "b/y.ts": [] });
    const dag = buildDomainDag(code, new Map([["a/x.ts", "d1"]]));
    expect([...(dag.get("d1") ?? [])]).toEqual([]);
    expect(dag.has("d2")).toBe(false);
  });

  it("feeds dependencyWaves to order domains leaves-first", () => {
    const code = indexFromDeps({
      "svc.ts": ["writer.ts"],
      "writer.ts": ["dag.ts"],
      "dag.ts": [],
    });
    const fileToDomain = new Map([
      ["svc.ts", "orchestration"],
      ["writer.ts", "generation"],
      ["dag.ts", "graph"],
    ]);
    const dag = buildDomainDag(code, fileToDomain);
    const waves = dependencyWaves(dag, new Set(dag.keys()));
    expect(waves).toEqual([[["graph"]], [["generation"]], [["orchestration"]]]);
  });

  it("keeps mutually dependent domains as one SCC group", () => {
    const code = indexFromDeps({ "x.ts": ["y.ts"], "y.ts": ["x.ts"] });
    const dag = buildDomainDag(
      code,
      new Map([
        ["x.ts", "a"],
        ["y.ts", "b"],
      ])
    );
    const waves = dependencyWaves(dag, new Set(dag.keys()));
    expect(waves).toEqual([[["a", "b"]]]);
  });
});
