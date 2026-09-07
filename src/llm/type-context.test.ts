import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeIndex, EntityImportSpecifier } from "../types.js";
import { collectTypeContext, TYPE_DECL_CAP } from "./type-context.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function specifier(overrides: Partial<EntityImportSpecifier>): EntityImportSpecifier {
  return {
    localName: "RewriteInput",
    importedName: "RewriteInput",
    moduleSpecifier: "../types.js",
    resolvedPath: "src/types.ts",
    isTypeOnly: true,
    isStdlib: false,
    isExternal: false,
    isReferenced: true,
    ...overrides,
  };
}

function fixture(
  specifiers: EntityImportSpecifier[],
  source = "function fn(input: RewriteInput) { return input; }"
): { sections: Array<{ entityId: string; source: string }>; code: CodeIndex } {
  const code = {
    entities: {
      "symbol:src/service/a.ts#fn": {
        id: "symbol:src/service/a.ts#fn",
        path: "src/service/a.ts",
        range: { startOffset: 0, endOffset: 10 },
        metadata: { imports: { specifiers } },
      },
    },
    fileToEntities: { "src/service/a.ts": ["symbol:src/service/a.ts#fn"], "src/types.ts": [] },
  } as unknown as CodeIndex;
  return { sections: [{ entityId: "symbol:src/service/a.ts#fn", source }], code };
}

async function makeProject(typesSource: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "type-context-"));
  tempDirs.push(rootDir);
  await mkdir(join(rootDir, "src"), { recursive: true });
  await writeFile(join(rootDir, "src/types.ts"), typesSource, "utf8");
  return rootDir;
}

describe("collectTypeContext", () => {
  it("extracts the referenced interface declaration without comments", async () => {
    const rootDir = await makeProject(
      [
        "/** Doc comment. */",
        "export interface RewriteInput {",
        "  sectionId: string;",
        "  showFiltered?: boolean; // optional flag",
        "}",
        "export interface Unrelated { x: number; }",
      ].join("\n")
    );
    const { sections, code } = fixture([specifier({})]);

    const declarations = await collectTypeContext({ sections, code, rootDir });

    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({ name: "RewriteInput", sourcePath: "src/types.ts" });
    expect(declarations[0].declaration).toContain("showFiltered?: boolean;");
    expect(declarations[0].declaration).not.toContain("Doc comment");
    expect(declarations[0].declaration).not.toContain("optional flag");
    expect(declarations[0].declaration).not.toContain("Unrelated");
  });

  it("skips external, stdlib and value imports", async () => {
    const rootDir = await makeProject("export interface RewriteInput { x: number; }");
    const { sections, code } = fixture([
      specifier({ isExternal: true }),
      specifier({ isStdlib: true }),
      specifier({ isTypeOnly: false }),
      specifier({ importedName: "*" }),
    ]);

    await expect(collectTypeContext({ sections, code, rootDir })).resolves.toEqual([]);
  });

  it("skips types not mentioned in the section source slice", async () => {
    const rootDir = await makeProject("export interface RewriteInput { x: number; }");
    const { sections, code } = fixture([specifier({})], "function fn() { return 1; }");

    await expect(collectTypeContext({ sections, code, rootDir })).resolves.toEqual([]);
  });

  it("caps an oversized declaration", async () => {
    const rootDir = await makeProject(`export interface RewriteInput {\n${'  field: "x";\n'.repeat(400)}}`);
    const { sections, code } = fixture([specifier({})]);

    const declarations = await collectTypeContext({ sections, code, rootDir });

    expect(declarations[0].declaration.length).toBeLessThanOrEqual(TYPE_DECL_CAP + 20);
    expect(declarations[0].declaration).toContain("truncated");
  });
});
