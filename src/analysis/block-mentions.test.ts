import { describe, expect, it } from "vitest";
import { mentionedDependencies } from "./block-mentions.js";

const candidates = [
  { sourcePath: "src/errors.ts", names: ["CodeloreError", "toCodeloreErrorPayload"] },
  { sourcePath: "src/service/prepare-docs.ts", names: ["withPreservedBlockBodies", "emptyDocState"] },
];

describe("mentionedDependencies", () => {
  it("finds a dependency named by path", () => {
    expect(mentionedDependencies("Скелет строится в `src/service/prepare-docs.ts`.", candidates)).toEqual([
      "src/service/prepare-docs.ts",
    ]);
  });

  it("finds a dependency named by a backticked symbol", () => {
    expect(mentionedDependencies("Бросает `CodeloreError` при дубликате.", candidates)).toEqual(["src/errors.ts"]);
  });

  it("finds a symbol named in plain prose, which is how prose usually names it", () => {
    expect(mentionedDependencies("При дубликате секции выбрасывается CodeloreError.", candidates)).toEqual([
      "src/errors.ts",
    ]);
  });

  it("says nothing about a block that names neither", () => {
    expect(mentionedDependencies("Возвращает отсортированный список путей документов.", candidates)).toEqual([]);
  });

  it("ignores short names, which match noise rather than evidence", () => {
    expect(
      mentionedDependencies("Каждый id попадает в map.", [{ sourcePath: "src/x.ts", names: ["id", "map"] }])
    ).toEqual([]);
  });

  it("has nothing to say about an empty block", () => {
    expect(mentionedDependencies("   ", candidates)).toEqual([]);
  });

  it("reports every dependency the block leans on, not just the first", () => {
    const body = "Скелет из `emptyDocState`, ошибки через `CodeloreError`.";
    expect(mentionedDependencies(body, candidates).sort()).toEqual(["src/errors.ts", "src/service/prepare-docs.ts"]);
  });
});
