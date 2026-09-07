import { describe, expect, it } from "vitest";
import { DOC_STATE_VERSION } from "../storage/doc-state-storage.js";
import type { CodeEntity, DocState, DocStateBlock } from "../types.js";
import { reconcileDocStateWithCode } from "./doc-reconcile.js";

function block(body: string): DocStateBlock {
  return { body, rendered: true };
}

function entity(id: string, allowedBlocks: string[]): CodeEntity {
  return {
    id,
    type: "function",
    path: "src/x.ts",
    name: id,
    signature: id,
    range: { startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
    directDeps: [],
    directUsages: [],
    contentHash: "h",
    facets: { signature: "s", body: "b", deps: "d", usage: "u", placement: "p" },
    // biome-ignore lint/suspicious/noExplicitAny: only allowedBlocks is read by reconcile
    metadata: { allowedBlocks } as any,
  };
}

function stateWith(sectionId: string, blocks: string[]): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath: "src/x.codelore.md",
    generatedAt: new Date().toISOString(),
    sectionOrder: [sectionId],
    sections: {
      [sectionId]: {
        heading: "x",
        depth: 2,
        anchor: "x",
        owns: [sectionId],
        depends: [],
        usedBy: [],
        status: "normal",
        // biome-ignore lint/suspicious/noExplicitAny: test fixture block ids
        allowedBlocks: blocks as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture block ids
        blockOrder: blocks as any,
        blocks: Object.fromEntries(blocks.map((b) => [b, block(`${b} text`)])),
      },
    },
  };
}

describe("reconcileDocStateWithCode", () => {
  it("drops blocks the entity no longer allows", () => {
    const id = "symbol:src/x.ts#shrunk";
    const state = stateWith(id, ["purpose", "changeGuide"]);
    const entities = { [id]: entity(id, ["purpose"]) };

    const changed = reconcileDocStateWithCode(state, entities);

    expect(changed).toBe(true);
    const section = state.sections[id];
    expect(Object.keys(section.blocks)).toEqual(["purpose"]);
    expect(section.blockOrder).toEqual(["purpose"]);
    expect(section.allowedBlocks).toEqual(["purpose"]);
  });

  it("removes sections whose owner entity is gone", () => {
    const id = "symbol:src/x.ts#deleted";
    const state = stateWith(id, ["purpose"]);

    const changed = reconcileDocStateWithCode(state, {});

    expect(changed).toBe(true);
    expect(state.sectionOrder).toEqual([]);
    expect(state.sections[id]).toBeUndefined();
  });

  it("leaves a section untouched when every block is still allowed", () => {
    const id = "symbol:src/x.ts#stable";
    const state = stateWith(id, ["purpose", "responsibility"]);
    const entities = { [id]: entity(id, ["purpose", "responsibility"]) };

    expect(reconcileDocStateWithCode(state, entities)).toBe(false);
  });
});
