import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AstHitFilter } from "./ast-hit-filter.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AstHitFilter", () => {
  it("accepts StringLiteral, rejects Identifier, comments, and import paths with same text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codelore-filter-"));
    tempDirs.push(dir);

    const file = join(dir, "mixed.ts");
    const text = [
      "import { thing } from 'TOKEN';", // literal in import path
      "const TOKEN = 1;", // Identifier
      "// see 'TOKEN' for details", // comment
      "function call() { inject('TOKEN'); }", // valid StringLiteral
    ].join("\n");
    await writeFile(file, text, "utf8");

    const filter = new AstHitFilter();

    const importHit = { file, line: 1, column: text.split("\n")[0].indexOf("'TOKEN'") + 2, matched: "TOKEN" };
    const identifierHit = { file, line: 2, column: text.split("\n")[1].indexOf("TOKEN") + 1, matched: "TOKEN" };
    const commentLine = text.split("\n")[2];
    const commentHit = { file, line: 3, column: commentLine.indexOf("'TOKEN'") + 2, matched: "TOKEN" };
    const callLine = text.split("\n")[3];
    const callHit = { file, line: 4, column: callLine.indexOf("'TOKEN'") + 2, matched: "TOKEN" };

    expect(filter.filter(importHit, "TOKEN")).toBeNull();
    expect(filter.filter(identifierHit, "TOKEN")).toBeNull();
    expect(filter.filter(commentHit, "TOKEN")).toBeNull();
    expect(filter.filter(callHit, "TOKEN")).not.toBeNull();
  });

  it("rejects literals in type declarations and literals typed by a literal union", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codelore-filter-"));
    tempDirs.push(dir);

    const file = join(dir, "typed.ts");
    const lines = [
      "type EntityType = 'class' | 'method';", // type space
      "declare const entity: { type: EntityType };",
      "const isClass = entity.type === 'class';", // typed comparison
      "declare function emit(event: string): void;",
      "emit('class');", // stringly-typed, must survive
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const filter = new AstHitFilter();

    const typeHit = { file, line: 1, column: lines[0].indexOf("'class'") + 2, matched: "class" };
    const comparisonHit = { file, line: 3, column: lines[2].indexOf("'class'") + 2, matched: "class" };
    const emitHit = { file, line: 5, column: lines[4].indexOf("'class'") + 2, matched: "class" };

    expect(filter.filter(typeHit, "class")).toBeNull();
    expect(filter.filter(comparisonHit, "class")).toBeNull();
    expect(filter.filter(emitHit, "class")).not.toBeNull();
  });
});
