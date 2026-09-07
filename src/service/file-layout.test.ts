import { describe, expect, it } from "vitest";
import type { CodeEntity, EntityType } from "../types.js";
import { planFileLayout } from "./file-layout.js";

function entity(
  partial: Partial<CodeEntity> & { id: string; name: string; type: EntityType; startOffset: number }
): CodeEntity {
  return {
    id: partial.id,
    type: partial.type,
    path: partial.path ?? "src/example.ts",
    name: partial.name,
    signature: partial.signature ?? partial.name,
    range: {
      startOffset: partial.startOffset,
      endOffset: partial.startOffset + 10,
      startLine: 1,
      endLine: 1,
    },
    directDeps: partial.directDeps ?? [],
    directUsages: partial.directUsages ?? [],
    contentHash: partial.contentHash ?? "hash",
    facets: partial.facets ?? {
      signature: partial.signature ?? partial.name,
      body: "",
      deps: "",
      usage: "",
      placement: "",
    },
  };
}

describe("planFileLayout", () => {
  it("emits all top-level entities at depth 1 for a functions-only file", () => {
    const plan = planFileLayout([
      entity({ id: "symbol:src/a.ts#foo", name: "foo", type: "function", startOffset: 0 }),
      entity({ id: "symbol:src/a.ts#bar", name: "bar", type: "function", startOffset: 100 }),
    ]);

    expect(plan).toEqual([
      expect.objectContaining({ depth: 1, heading: "foo" }),
      expect.objectContaining({ depth: 1, heading: "bar" }),
    ]);
  });

  it("heads the module section with the file basename and puts it first", () => {
    const plan = planFileLayout([
      entity({
        id: "symbol:src/graph/file-dag.ts#buildFileDag",
        name: "buildFileDag",
        type: "function",
        startOffset: 50,
      }),
      entity({ id: "file:src/graph/file-dag.ts", name: "src/graph/file-dag.ts", type: "file", startOffset: 0 }),
    ]);

    expect(plan).toEqual([
      expect.objectContaining({ depth: 1, heading: "file-dag.ts" }),
      expect.objectContaining({ depth: 1, heading: "buildFileDag" }),
    ]);
  });

  it("nests methods under their class at depth 2 with short headings", () => {
    const plan = planFileLayout([
      entity({ id: "symbol:src/a.ts#Skill", name: "Skill", type: "class", startOffset: 0 }),
      entity({ id: "symbol:src/a.ts#Skill.loadSkills", name: "Skill.loadSkills", type: "method", startOffset: 50 }),
      entity({ id: "symbol:src/a.ts#Skill.parseSkill", name: "Skill.parseSkill", type: "method", startOffset: 100 }),
    ]);

    expect(plan).toEqual([
      expect.objectContaining({ depth: 1, heading: "Skill" }),
      expect.objectContaining({ depth: 2, heading: "loadSkills" }),
      expect.objectContaining({ depth: 2, heading: "parseSkill" }),
    ]);
  });

  it("keeps two classes as independent H1 sections with their own methods", () => {
    const plan = planFileLayout([
      entity({ id: "symbol:src/a.ts#Skill", name: "Skill", type: "class", startOffset: 0 }),
      entity({ id: "symbol:src/a.ts#Skill.loadSkills", name: "Skill.loadSkills", type: "method", startOffset: 50 }),
      entity({ id: "symbol:src/a.ts#ParserSkills", name: "ParserSkills", type: "class", startOffset: 200 }),
      entity({ id: "symbol:src/a.ts#ParserSkills.init", name: "ParserSkills.init", type: "method", startOffset: 250 }),
    ]);

    expect(plan.map((item) => ({ depth: item.depth, heading: item.heading }))).toEqual([
      { depth: 1, heading: "Skill" },
      { depth: 2, heading: "loadSkills" },
      { depth: 1, heading: "ParserSkills" },
      { depth: 2, heading: "init" },
    ]);
  });

  it("emits a free function and a class as siblings at depth 1", () => {
    const plan = planFileLayout([
      entity({ id: "symbol:src/a.ts#helper", name: "helper", type: "function", startOffset: 0 }),
      entity({ id: "symbol:src/a.ts#Skill", name: "Skill", type: "class", startOffset: 100 }),
      entity({ id: "symbol:src/a.ts#Skill.run", name: "Skill.run", type: "method", startOffset: 150 }),
    ]);

    expect(plan.map((item) => ({ depth: item.depth, heading: item.heading }))).toEqual([
      { depth: 1, heading: "helper" },
      { depth: 1, heading: "Skill" },
      { depth: 2, heading: "run" },
    ]);
  });

  it("falls back to depth 1 with fully-qualified heading for a method whose class is not in the batch", () => {
    const plan = planFileLayout([
      entity({ id: "symbol:src/a.ts#Orphan.run", name: "Orphan.run", type: "method", startOffset: 0 }),
    ]);

    expect(plan).toEqual([expect.objectContaining({ depth: 1, heading: "Orphan.run" })]);
  });
});
