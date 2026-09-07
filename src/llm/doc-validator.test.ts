import { describe, expect, it } from "vitest";
import type { BlockId } from "../markdown/block-ids.js";
import { buildEntityNameToIds, invalidRefsForBlock, validateFileWrite } from "./doc-validator.js";
import type { FileWriteSection, WrittenBlock } from "./file-writer.js";

const SECTION_ID = "symbol:src/a.ts#fn";

function section(overrides: Partial<FileWriteSection> = {}): FileWriteSection {
  return {
    sectionId: SECTION_ID,
    heading: "fn",
    entity: { id: SECTION_ID, name: "fn", type: "function", signature: "fn(): void" },
    allowedBlocks: ["purpose"] as BlockId[],
    targetBlocks: ["purpose"] as BlockId[],
    existingBlocks: [],
    callers: [{ id: "symbol:src/caller.ts#use", path: "src/caller.ts", signature: "use()", kind: "static", body: "" }],
    dependencyEntityIds: ["symbol:src/dep.ts#helper"],
    ...overrides,
  };
}

function written(text: string, refs: string[]): WrittenBlock {
  return { text, refs, novelFact: "f", informativeness: 0.75, novelty: 0.75, specificity: 0.75 };
}

function baseInput(blockRefs: string[], overrides: Partial<Parameters<typeof validateFileWrite>[0]> = {}) {
  return {
    result: { [SECTION_ID]: { purpose: written("текст", blockRefs) } },
    sections: [section()],
    groupFiles: ["src/a.ts"],
    knownEntityIds: new Set([
      SECTION_ID,
      "symbol:src/caller.ts#use",
      "symbol:src/dep.ts#helper",
      "symbol:src/far.ts#x",
    ]),
    knownFiles: new Set(["src/a.ts", "src/caller.ts", "src/dep.ts", "src/far.ts"]),
    dependencyDocPaths: new Set(["src/dep.ts"]),
    entityNameToIds: new Map<string, string[]>([
      ["fn", [SECTION_ID]],
      ["use", ["symbol:src/caller.ts#use"]],
      ["helper", ["symbol:src/dep.ts#helper"]],
      ["x", ["symbol:src/far.ts#x"]],
    ]),
    ...overrides,
  };
}

describe("invalidRefsForBlock", () => {
  const refContext = {
    groupFiles: ["src/a.ts"],
    knownEntityIds: new Set([
      SECTION_ID,
      "symbol:src/caller.ts#use",
      "symbol:src/dep.ts#helper",
      "symbol:src/far.ts#x",
    ]),
    knownFiles: new Set(["src/a.ts", "src/caller.ts", "src/dep.ts", "src/far.ts"]),
    dependencyDocPaths: new Set(["src/dep.ts"]),
  };

  it("returns only the refs that fail deterministic checks, keeping valid ones", () => {
    const bad = invalidRefsForBlock(
      section(),
      "purpose" as BlockId,
      [SECTION_ID, "symbol:src/far.ts#x", "symbol:src/ghost.ts#nope"],
      refContext
    );
    expect(bad).toEqual(["symbol:src/far.ts#x", "symbol:src/ghost.ts#nope"]);
  });

  it("returns [] when every ref is grounded", () => {
    expect(invalidRefsForBlock(section(), "purpose" as BlockId, [SECTION_ID, "src/dep.ts"], refContext)).toEqual([]);
  });
});

describe("validateFileWrite", () => {
  it("accepts refs to own entity, callers, deps, dep docs, and own file", () => {
    const refs = [SECTION_ID, "symbol:src/caller.ts#use", "symbol:src/dep.ts#helper", "src/dep.ts", "src/a.ts"];
    expect(validateFileWrite(baseInput(refs))).toEqual([]);
  });

  it("flags refs that do not exist in the index", () => {
    const violations = validateFileWrite(baseInput(["symbol:src/ghost.ts#nope"]));
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("unknown_ref");
    expect(violations[0].blockId).toBe("purpose");
  });

  it("accepts a file:-prefixed ref to a dependency's path, own path, or dep doc path", () => {
    const refs = ["file:src/dep.ts", "file:src/a.ts"];
    expect(validateFileWrite(baseInput(refs))).toEqual([]);
  });

  it("flags refs that exist but are outside the section context", () => {
    const violations = validateFileWrite(baseInput(["symbol:src/far.ts#x"]));
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("ref_outside_context");
  });

  it("flags oversized block text", () => {
    const input = baseInput([]);
    input.result[SECTION_ID].purpose = written("x".repeat(2501), []);
    const violations = validateFileWrite(input);
    expect(violations.map((entry) => entry.rule)).toEqual(["text_too_long"]);
  });

  it("flags mentioned paths that do not exist, accepts real ones", () => {
    const input = {
      ...baseInput([]),
      fileExists: (path: string) => path === "src/a.test.ts",
    };
    input.result[SECTION_ID].purpose = written(
      "Проверять тестом src/a.test.ts и снапшотом src/__snapshots__/a.test.ts.snap.",
      []
    );
    const violations = validateFileWrite(input);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "path_not_found" });
    expect(violations[0].detail).toContain("src/__snapshots__/a.test.ts.snap");
  });

  it("accepts NodeNext import paths whose .ts source exists", () => {
    const input = {
      ...baseInput([]),
      fileExists: (path: string) => path === "src/provider.ts",
    };
    input.result[SECTION_ID].purpose = written("Импортирует src/provider.js по NodeNext-конвенции.", []);
    expect(validateFileWrite(input)).toEqual([]);
  });

  it("skips path checking when fileExists is not provided", () => {
    const input = baseInput([]);
    input.result[SECTION_ID].purpose = written("См. src/ghost/nothing.ts.", []);
    expect(validateFileWrite(input)).toEqual([]);
  });

  it("flags a caller cited in the dependencies block", () => {
    const input = baseInput([]);
    input.result[SECTION_ID] = { dependencies: written("Использует use.", ["symbol:src/caller.ts#use"]) };
    const violations = validateFileWrite(input);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "ref_role_mismatch", blockId: "dependencies" });
  });

  it("accepts a real dependency in the dependencies block", () => {
    const input = baseInput([]);
    input.result[SECTION_ID] = { dependencies: written("Использует helper.", ["symbol:src/dep.ts#helper"]) };
    expect(validateFileWrite(input)).toEqual([]);
  });

  it("does not flag an id that is both caller and dependency (cycle)", () => {
    const dual = "symbol:src/dual.ts#both";
    const input = baseInput([], {
      sections: [
        section({
          callers: [{ id: dual, path: "src/dual.ts", signature: "both()", kind: "static", body: "" }],
          dependencyEntityIds: [dual],
        }),
      ],
      knownEntityIds: new Set([SECTION_ID, dual]),
      knownFiles: new Set(["src/a.ts", "src/dual.ts"]),
      dependencyDocPaths: new Set<string>(),
    });
    input.result[SECTION_ID] = { dependencies: written("Взаимная зависимость both.", [dual]) };
    expect(validateFileWrite(input)).toEqual([]);
  });

  it("does not flag a caller cited in the workflows block", () => {
    const input = baseInput([]);
    input.result[SECTION_ID] = { workflows: written("Вызывается из use.", ["symbol:src/caller.ts#use"]) };
    expect(validateFileWrite(input)).toEqual([]);
  });

  it("flags a symbol named only in prose that is outside the section context", () => {
    const input = baseInput([]);
    input.result[SECTION_ID] = { workflows: written("Вызывается из `x` напрямую.", []) };
    const violations = validateFileWrite(input);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "ref_outside_context", blockId: "workflows" });
    expect(violations[0].detail).toContain("x");
  });

  it("accepts a caller named in prose", () => {
    const input = baseInput([]);
    input.result[SECTION_ID] = { workflows: written("Вызывается из `use()` на старте.", []) };
    expect(validateFileWrite(input)).toEqual([]);
  });

  it("ignores backtick code expressions that are not symbols", () => {
    const input = baseInput([]);
    input.result[SECTION_ID] = { workflows: written("Сортирует через `[...groups].sort()`.", []) };
    expect(validateFileWrite(input)).toEqual([]);
  });

  it("flags a bare method name from outside the section context (delegate internals)", () => {
    const input = baseInput([], {
      entityNameToIds: buildEntityNameToIds({
        [SECTION_ID]: { name: "fn" },
        "symbol:src/storage.ts#Storage.reapplyConfigToAllDocs": { name: "Storage.reapplyConfigToAllDocs" },
      }),
    });
    input.result[SECTION_ID] = { purpose: written("Применяет конфигурацию через `reapplyConfigToAllDocs`.", []) };
    const violations = validateFileWrite(input);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("ref_outside_context");
  });
});

describe("buildEntityNameToIds", () => {
  it("indexes methods by both 'Class.method' and the bare method name", () => {
    const map = buildEntityNameToIds({
      "symbol:src/a.ts#A.run": { name: "A.run" },
      "symbol:src/b.ts#B.run": { name: "B.run" },
      "symbol:src/c.ts#standalone": { name: "standalone" },
    });
    expect(map.get("A.run")).toEqual(["symbol:src/a.ts#A.run"]);
    expect(map.get("run")).toEqual(["symbol:src/a.ts#A.run", "symbol:src/b.ts#B.run"]);
    expect(map.get("standalone")).toEqual(["symbol:src/c.ts#standalone"]);
  });
});
