import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildCodeIndex } from "../indexer/code-indexer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codelore-metrics-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(dir, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return dir;
}

describe("entity-metrics: per-specifier import tracking", () => {
  it("flags declaration-level isTypeOnly for all specifiers", async () => {
    const rootDir = await makeTempProject({
      "src/helper.ts": "export type Foo = { value: number };\nexport const bar = 1;\n",
      "src/main.ts": [
        "import type { Foo } from './helper';",
        "export function use(x: Foo): number {",
        "  return x.value;",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));
    const specifiers = index.entities["symbol:src/main.ts#use"]?.metadata?.imports.specifiers ?? [];
    const foo = specifiers.find((spec) => spec.localName === "Foo");

    expect(foo).toBeDefined();
    expect(foo?.isTypeOnly).toBe(true);
  });

  it("tracks per-specifier isTypeOnly in mixed imports", async () => {
    const rootDir = await makeTempProject({
      "src/helper.ts": ["export type Foo = { value: number };", "export const runtimeBar = 42;"].join("\n"),
      "src/main.ts": [
        "import { type Foo, runtimeBar } from './helper';",
        "export function use(x: Foo): number {",
        "  return x.value + runtimeBar;",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));
    const specifiers = index.entities["symbol:src/main.ts#use"]?.metadata?.imports.specifiers ?? [];
    const foo = specifiers.find((spec) => spec.localName === "Foo");
    const runtime = specifiers.find((spec) => spec.localName === "runtimeBar");

    expect(foo?.isTypeOnly).toBe(true);
    expect(runtime?.isTypeOnly).toBe(false);
  });

  it("resolves a folder import to its index file", async () => {
    const rootDir = await makeTempProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "bundler" } }),
      "src/utils/index.ts": "export type Foo = { value: number };\n",
      "src/main.ts": [
        "import type { Foo } from './utils';",
        "export function use(x: Foo): number {",
        "  return x.value;",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));
    const specifiers = index.entities["symbol:src/main.ts#use"]?.metadata?.imports.specifiers ?? [];
    const foo = specifiers.find((spec) => spec.localName === "Foo");

    expect(foo?.resolvedPath).toBe("src/utils/index.ts");
  });

  it("classifies node: imports as stdlib and unknown modules as external non-stdlib", async () => {
    const rootDir = await makeTempProject({
      "src/main.ts": [
        "import { readFile } from 'node:fs/promises';",
        "import fastGlob from 'fast-glob';",
        "export async function use(): Promise<string> {",
        "  const files = await fastGlob(['*.ts']);",
        "  return readFile(files[0], 'utf8');",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));
    const specifiers = index.entities["symbol:src/main.ts#use"]?.metadata?.imports.specifiers ?? [];

    const readFileSpec = specifiers.find((spec) => spec.localName === "readFile");
    const fastGlobSpec = specifiers.find((spec) => spec.localName === "fastGlob");

    expect(readFileSpec?.isStdlib).toBe(true);
    expect(fastGlobSpec?.isStdlib).toBe(false);
    expect(fastGlobSpec?.isExternal).toBe(true);
  });

  it("marks isReferenced based on usage in the entity body", async () => {
    const rootDir = await makeTempProject({
      "src/main.ts": [
        "import { readFile, writeFile } from 'node:fs/promises';",
        "export async function justRead(path: string): Promise<string> {",
        "  return readFile(path, 'utf8');",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));
    const specifiers = index.entities["symbol:src/main.ts#justRead"]?.metadata?.imports.specifiers ?? [];

    expect(specifiers.find((spec) => spec.localName === "readFile")?.isReferenced).toBe(true);
    expect(specifiers.find((spec) => spec.localName === "writeFile")?.isReferenced).toBe(false);
  });
});

describe("entity-metrics: statement counting", () => {
  it("counts each statement once regardless of nested calls and awaits", async () => {
    // Regression: isStatementSignal used to include CallExpression/AwaitExpression,
    // so getDescendants().filter double/triple-counted nested expressions.
    // Body below is exactly 2 statements; the buggy version reported 8.
    const rootDir = await makeTempProject({
      "src/main.ts": [
        "export async function work(): Promise<number> {",
        "  const x = await foo(bar());",
        "  return baz(await qux());",
        "}",
        "declare function foo(n: number): Promise<number>;",
        "declare function bar(): number;",
        "declare function baz(n: number): number;",
        "declare function qux(): Promise<number>;",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/main.ts#work"]?.metadata?.statementCount).toBe(2);
  });

  it("counts nested block statements at every depth", async () => {
    const rootDir = await makeTempProject({
      "src/main.ts": [
        "export function branch(x: number): number {",
        "  if (x > 0) {", // IfStatement
        "    return x;", // ReturnStatement
        "  }",
        "  const y = x * 2;", // VariableStatement
        "  return y;", // ReturnStatement
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/main.ts#branch"]?.metadata?.statementCount).toBe(4);
  });
});

describe("entity-metrics: significant globals", () => {
  it("detects process.env usage", async () => {
    const rootDir = await makeTempProject({
      "src/main.ts": ["export function readEnv(): string | undefined {", "  return process.env.NODE_ENV;", "}"].join(
        "\n"
      ),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));
    const globals = index.entities["symbol:src/main.ts#readEnv"]?.metadata?.globals.used ?? [];

    expect(globals.find((entry) => entry.name === "process")).toBeDefined();
    expect(globals.find((entry) => entry.name === "process")?.access).toContain("process.env");
  });

  it("does not flag baseline globals like Math or console", async () => {
    const rootDir = await makeTempProject({
      "src/main.ts": [
        "export function square(x: number): number {",
        "  console.log(x);",
        "  return Math.pow(x, 2);",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));
    const globals = index.entities["symbol:src/main.ts#square"]?.metadata?.globals.used ?? [];

    expect(globals).toEqual([]);
  });
});
