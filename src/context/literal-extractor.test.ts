import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import type { SourceRange } from "../types.js";
import { extractLiterals } from "./literal-extractor.js";

describe("extractLiterals", () => {
  it("extracts StringLiteral and NoSubstitutionTemplateLiteral, drops short, jsdoc, template-expr, import", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = [
      "import { thing } from './a';",
      "/** @see 'foo' */",
      "function target(x: string) {",
      "  emit('user.registered');",
      "  on(`user.deleted`);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture text for AST input
      "  log(`hello ${x}`);",
      "  short('ok');",
      "}",
    ].join("\n");
    const sourceFile = project.createSourceFile("/virtual/target.ts", source);
    const fn = sourceFile.getFunctionOrThrow("target");
    const range: SourceRange = {
      startOffset: fn.getStart(),
      endOffset: fn.getEnd(),
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
    };

    const literals = extractLiterals(sourceFile, range);
    const values = literals.map((l) => l.value).sort();
    expect(values).toEqual(["user.deleted", "user.registered"]);

    const registered = literals.find((l) => l.value === "user.registered");
    expect(registered?.syntaxRole).toBe("CallExpression.arguments[0]");
  });

  it("skips literals typed by a declared literal union, keeps stringly-typed ones", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = [
      "type EntityType = 'class' | 'method' | 'function';",
      "declare const bus: { emit(event: string, payload: unknown): void };",
      "function target(entityType: EntityType) {",
      "  if (entityType === 'class') {",
      "    bus.emit('order.paid', {});",
      "  }",
      "  switch (entityType) {",
      "    case 'method':",
      "      break;",
      "  }",
      "}",
    ].join("\n");
    const sourceFile = project.createSourceFile("/virtual/typed.ts", source);
    const fn = sourceFile.getFunctionOrThrow("target");
    const range: SourceRange = {
      startOffset: fn.getStart(),
      endOffset: fn.getEnd(),
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
    };

    const values = extractLiterals(sourceFile, range).map((l) => l.value);
    expect(values).toEqual(["order.paid"]);
  });

  it("returns empty list when target has no literals", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      "/virtual/clean.ts",
      "function pure(x: number): number { return x + 1; }"
    );
    const fn = sourceFile.getFunctionOrThrow("pure");
    const range: SourceRange = {
      startOffset: fn.getStart(),
      endOffset: fn.getEnd(),
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
    };
    expect(extractLiterals(sourceFile, range)).toEqual([]);
  });
});
