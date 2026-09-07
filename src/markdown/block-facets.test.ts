import { describe, expect, it } from "vitest";
import type { CodeEntity } from "../types.js";
import { BLOCK_FACETS, computeBlockFingerprint } from "./block-facets.js";

function makeEntity(overrides: Partial<CodeEntity["facets"]> = {}): CodeEntity {
  return {
    id: "symbol:src/x.ts#fn",
    type: "function",
    path: "src/x.ts",
    name: "fn",
    signature: "fn()",
    range: { startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
    directDeps: [],
    directUsages: [],
    contentHash: "ch",
    facets: {
      signature: "s1",
      body: "b1",
      deps: "d1",
      usage: "u1",
      placement: "p1",
      ...overrides,
    },
  };
}

describe("computeBlockFingerprint", () => {
  it("returns undefined when there are no owned entities", () => {
    expect(computeBlockFingerprint("purpose", [], {})).toBeUndefined();
  });

  it("returns undefined when no owned entity is found in the entity map", () => {
    expect(computeBlockFingerprint("purpose", ["symbol:missing"], {})).toBeUndefined();
  });

  it("only reacts to changes in facets mapped to the block", () => {
    const baseline = makeEntity();
    const onlyBodyChanged = makeEntity({ body: "b2" });
    const entities = { [baseline.id]: baseline };
    const dependenciesFp = computeBlockFingerprint("dependencies", [baseline.id], entities);
    const dependenciesFpAfter = computeBlockFingerprint("dependencies", [baseline.id], {
      [baseline.id]: onlyBodyChanged,
    });

    expect(dependenciesFp).toBeDefined();
    expect(dependenciesFp).toBe(dependenciesFpAfter);
  });

  it("changes the fingerprint when a mapped facet changes", () => {
    const baseline = makeEntity();
    const depsChanged = makeEntity({ deps: "d2" });

    const before = computeBlockFingerprint("dependencies", [baseline.id], { [baseline.id]: baseline });
    const after = computeBlockFingerprint("dependencies", [baseline.id], { [baseline.id]: depsChanged });

    expect(before).not.toBe(after);
  });

  it("workflows reacts to body OR deps but not to signature alone", () => {
    const baseline = makeEntity();
    const sigChanged = makeEntity({ signature: "s2" });
    const bodyChanged = makeEntity({ body: "b2" });

    const baselineFp = computeBlockFingerprint("workflows", [baseline.id], { [baseline.id]: baseline });
    const sigFp = computeBlockFingerprint("workflows", [baseline.id], { [baseline.id]: sigChanged });
    const bodyFp = computeBlockFingerprint("workflows", [baseline.id], { [baseline.id]: bodyChanged });

    expect(sigFp).toBe(baselineFp);
    expect(bodyFp).not.toBe(baselineFp);
  });

  it("documents the facet map for each block id", () => {
    expect(BLOCK_FACETS.dependencies).toEqual(["deps"]);
    expect(BLOCK_FACETS.limitations).toEqual(["body"]);
    expect(BLOCK_FACETS.purpose).toContain("signature");
  });
});
