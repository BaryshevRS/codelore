import { describe, expect, it } from "vitest";
import type { CodeEntity, CodeIndex } from "../types.js";
import { buildFileDag, generationWaves } from "./file-dag.js";

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

describe("buildFileDag", () => {
  it("builds file-level edges from entity directDeps, ignoring same-file deps", () => {
    const code = indexFromDeps({ "a.ts": ["b.ts", "a.ts"], "b.ts": [] });
    const dag = buildFileDag(code);
    expect([...(dag.get("a.ts") ?? [])]).toEqual(["b.ts"]);
    expect([...(dag.get("b.ts") ?? [])]).toEqual([]);
  });
});

describe("generationWaves", () => {
  it("orders a chain leaves-first", () => {
    const code = indexFromDeps({ "a.ts": ["b.ts"], "b.ts": ["c.ts"], "c.ts": [] });
    expect(generationWaves(code, ["a.ts", "b.ts", "c.ts"])).toEqual([[["c.ts"]], [["b.ts"]], [["a.ts"]]]);
  });

  it("puts diamond siblings in the same wave", () => {
    const code = indexFromDeps({
      "top.ts": ["left.ts", "right.ts"],
      "left.ts": ["base.ts"],
      "right.ts": ["base.ts"],
      "base.ts": [],
    });
    expect(generationWaves(code, ["top.ts", "left.ts", "right.ts", "base.ts"])).toEqual([
      [["base.ts"]],
      [["left.ts"], ["right.ts"]],
      [["top.ts"]],
    ]);
  });

  it("collapses a cycle into one group ordered before its dependents", () => {
    const code = indexFromDeps({
      "x.ts": ["y.ts"],
      "y.ts": ["x.ts"],
      "user.ts": ["x.ts"],
    });
    expect(generationWaves(code, ["x.ts", "y.ts", "user.ts"])).toEqual([[["x.ts", "y.ts"]], [["user.ts"]]]);
  });

  it("ignores dependencies outside the requested scope", () => {
    const code = indexFromDeps({ "a.ts": ["b.ts"], "b.ts": [] });
    expect(generationWaves(code, ["a.ts"])).toEqual([[["a.ts"]]]);
  });

  it("handles an isolated file", () => {
    const code = indexFromDeps({ "solo.ts": [] });
    expect(generationWaves(code, ["solo.ts"])).toEqual([[["solo.ts"]]]);
  });
});
