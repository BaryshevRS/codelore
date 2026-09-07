import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildCodeIndex } from "./code-indexer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("buildCodeIndex", () => {
  it("indexes files, exported functions, classes, methods, and deterministic local deps", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": [
        "export function roundPrice(value: number): number {",
        "  return Math.round(value * 100) / 100;",
        "}",
        "",
        "export const buildPrice = (amount: number): number => {",
        "  return roundPrice(amount);",
        "};",
        "",
        "export class PriceBook {",
        "  current(amount: number): number {",
        "    return buildPrice(amount);",
        "  }",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    // Three documented symbols in one file → the file entity becomes the module section.
    expect(index.entities["file:src/pricing.ts"]).toMatchObject({
      type: "file",
      metadata: expect.objectContaining({ role: "short_page" }),
    });
    expect(index.entities["symbol:src/pricing.ts#roundPrice"]).toMatchObject({ type: "function" });
    expect(index.entities["symbol:src/pricing.ts#buildPrice"]).toMatchObject({ type: "function" });
    expect(index.entities["symbol:src/pricing.ts#PriceBook"]).toMatchObject({ type: "class" });
    expect(index.entities["symbol:src/pricing.ts#PriceBook.current"]).toMatchObject({ type: "method" });
    expect(index.entities["symbol:src/pricing.ts#buildPrice"].directDeps).toContain("symbol:src/pricing.ts#roundPrice");
    expect(index.entities["symbol:src/pricing.ts#PriceBook.current"].directDeps).toContain(
      "symbol:src/pricing.ts#buildPrice"
    );
  });

  it("keeps the file entity at one_line when the file yields fewer than two documented pages", async () => {
    const rootDir = await makeTempProject({
      "src/single.ts": ["export function onlyOne(value: number): number {", "  return value * 2;", "}"].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["file:src/single.ts"]).toMatchObject({
      type: "file",
      metadata: expect.objectContaining({ role: "one_line" }),
    });
  });

  it("does not record a phantom dep when a local binding shadows an entity name", async () => {
    const rootDir = await makeTempProject({
      "src/store.ts": [
        "export class Store {",
        "  reset(): void {}",
        "}",
        "",
        "export function process(reset: boolean): boolean {",
        "  return reset;",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/store.ts#process"].directDeps).not.toContain("symbol:src/store.ts#Store.reset");
    expect(index.entities["symbol:src/store.ts#process"].directDeps).toEqual([]);
  });

  it("resolves deps through namespace imports", async () => {
    const rootDir = await makeTempProject({
      "src/utils.ts": "export function helper(value: number): number {\n  return value + 1;\n}\n",
      "src/app.ts": [
        "import * as utils from './utils.js';",
        "export function run(value: number): number {",
        "  return utils.helper(value);",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/app.ts#run"].directDeps).toContain("symbol:src/utils.ts#helper");
  });

  it("supports only .ts and .js files in v1", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.js": "export function buildPrice(amount) { return amount; }\n",
      "src/component.tsx": "export function PriceView() { return <div />; }\n",
      "src/widget.jsx": "export function Widget() { return <div />; }\n",
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/pricing.js#buildPrice"]).toMatchObject({ type: "function" });
    expect(index.entities["symbol:src/component.tsx#PriceView"]).toBeUndefined();
    expect(index.entities["symbol:src/widget.jsx#Widget"]).toBeUndefined();
  });

  it("excludes configured test-like source files before indexing", async () => {
    const rootDir = await makeTempProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
      "src/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "src/app.ts": "import { add } from './math.js';\nexport function run(): number { return add(1, 2); }\n",
      "src/math.test.ts": "import { add } from './math.js';\nexport const result = add(1, 2);\n",
      "src/math.spec.ts": "import { add } from './math.js';\nexport const result = add(2, 3);\n",
      "src/__tests__/math.ts": "import { add } from '../math.js';\nexport const result = add(3, 4);\n",
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["file:src/math.test.ts"]).toBeUndefined();
    expect(index.entities["file:src/math.spec.ts"]).toBeUndefined();
    expect(index.entities["file:src/__tests__/math.ts"]).toBeUndefined();
    expect(index.entities["symbol:src/math.ts#add"].directUsages).toEqual(["file:src/app.ts", "symbol:src/app.ts#run"]);
    expect(index.entities["symbol:src/math.ts#add"].directUsages).not.toContain("file:src/math.test.ts");
  });

  it("indexes .js files even when tsconfig is present", async () => {
    const rootDir = await makeTempProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
      "src/pricing.js": "export function buildPrice(amount) { return amount; }\n",
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/pricing.js#buildPrice"]).toMatchObject({ type: "function" });
  });

  it("does not record declaration files from dependencies as direct deps", async () => {
    const rootDir = await makeTempProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
        },
        include: ["src/**/*.ts"],
      }),
      "node_modules/external-lib/index.d.ts": [
        "export default function setup(): void;",
        "export function external(value: string): string;",
      ].join("\n"),
      "src/consumer.ts": [
        "import setup, { external } from 'external-lib';",
        "",
        "export function consume(value: string): string {",
        "  setup();",
        "  return external(value);",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/consumer.ts#consume"].directDeps).toEqual([]);
    expect(
      Object.values(index.entities)
        .flatMap((entity) => entity.directDeps)
        .some((dep) => dep.includes("node_modules"))
    ).toBe(false);
  });

  it("marks a thin public wrapper as the page anchor for a private implementation", async () => {
    const rootDir = await makeTempProject({
      "src/repository.ts": [
        "export class Repository {",
        "  load(): number {",
        "    return this.loadImpl();",
        "  }",
        "",
        "  private loadImpl(): number {",
        "    const first = 1;",
        "    const second = 2;",
        "    const third = 3;",
        "    const fourth = 4;",
        "    const fifth = 5;",
        "    const sixth = 6;",
        "    return first + second + third + fourth + fifth + sixth;",
        "  }",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/repository.ts#Repository.load"].metadata).toMatchObject({
      role: "full_page",
      anchorPrivate: "symbol:src/repository.ts#Repository.loadImpl",
    });
    expect(index.entities["symbol:src/repository.ts#Repository.loadImpl"].metadata).toMatchObject({
      role: "absorbed_by_caller",
      absorbedBy: "symbol:src/repository.ts#Repository.load",
    });
  });

  it("changes body facet but not signature facet when only the function body changes", async () => {
    const before = await makeTempProject({
      "src/calc.ts": ["export function add(a: number, b: number): number {", "  return a + b;", "}"].join("\n"),
    });
    const after = await makeTempProject({
      "src/calc.ts": ["export function add(a: number, b: number): number {", "  return b + a;", "}"].join("\n"),
    });

    const beforeIndex = await buildCodeIndex(loadConfig(before));
    const afterIndex = await buildCodeIndex(loadConfig(after));
    const beforeEntity = beforeIndex.entities["symbol:src/calc.ts#add"];
    const afterEntity = afterIndex.entities["symbol:src/calc.ts#add"];

    expect(afterEntity.facets.signature).toBe(beforeEntity.facets.signature);
    expect(afterEntity.facets.placement).toBe(beforeEntity.facets.placement);
    expect(afterEntity.facets.body).not.toBe(beforeEntity.facets.body);
  });

  it("changes signature facet when a parameter is renamed or retyped", async () => {
    const before = await makeTempProject({
      "src/calc.ts": ["export function add(a: number, b: number): number {", "  return a + b;", "}"].join("\n"),
    });
    const after = await makeTempProject({
      "src/calc.ts": ["export function add(left: number, right: number): number {", "  return left + right;", "}"].join(
        "\n"
      ),
    });

    const beforeEntity = (await buildCodeIndex(loadConfig(before))).entities["symbol:src/calc.ts#add"];
    const afterEntity = (await buildCodeIndex(loadConfig(after))).entities["symbol:src/calc.ts#add"];

    expect(afterEntity.facets.signature).not.toBe(beforeEntity.facets.signature);
    expect(afterEntity.facets.body).not.toBe(beforeEntity.facets.body);
  });

  it("changes deps facet for callers when a callee is added", async () => {
    const before = await makeTempProject({
      "src/calc.ts": [
        "export function helper(x: number): number { return x * 2; }",
        "export function root(): number { return 1; }",
      ].join("\n"),
    });
    const after = await makeTempProject({
      "src/calc.ts": [
        "export function helper(x: number): number { return x * 2; }",
        "export function root(): number { return helper(1); }",
      ].join("\n"),
    });

    const beforeRoot = (await buildCodeIndex(loadConfig(before))).entities["symbol:src/calc.ts#root"];
    const afterRoot = (await buildCodeIndex(loadConfig(after))).entities["symbol:src/calc.ts#root"];
    const afterHelper = (await buildCodeIndex(loadConfig(after))).entities["symbol:src/calc.ts#helper"];

    expect(afterRoot.facets.deps).not.toBe(beforeRoot.facets.deps);
    expect(afterHelper.directUsages).toContain("symbol:src/calc.ts#root");
  });

  it("changes usage facet on callee when a caller is removed", async () => {
    const before = await makeTempProject({
      "src/calc.ts": [
        "export function helper(x: number): number { return x * 2; }",
        "export function root(): number { return helper(1); }",
      ].join("\n"),
    });
    const after = await makeTempProject({
      "src/calc.ts": [
        "export function helper(x: number): number { return x * 2; }",
        "export function root(): number { return 1; }",
      ].join("\n"),
    });

    const beforeHelper = (await buildCodeIndex(loadConfig(before))).entities["symbol:src/calc.ts#helper"];
    const afterHelper = (await buildCodeIndex(loadConfig(after))).entities["symbol:src/calc.ts#helper"];

    expect(afterHelper.facets.usage).not.toBe(beforeHelper.facets.usage);
    expect(afterHelper.facets.body).toBe(beforeHelper.facets.body);
  });

  it("absorbs methods into a cohesive class page through the internal call graph", async () => {
    const rootDir = await makeTempProject({
      "src/storage.ts": [
        "import { readFile, writeFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        "",
        "export class JsonStorage {",
        "  constructor(private readonly rootDir: string) {}",
        "  async save(value: unknown): Promise<void> { await this.writeJson(this.path(), value); }",
        "  async load(): Promise<unknown> { return this.readJson(this.path()); }",
        "  path(): string { return join(this.rootDir, 'index.json'); }",
        "  private async writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, JSON.stringify(value)); }",
        "  private async readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }",
        "}",
      ].join("\n"),
    });

    const index = await buildCodeIndex(loadConfig(rootDir));

    expect(index.entities["symbol:src/storage.ts#JsonStorage"].metadata).toMatchObject({
      role: "full_page",
      hasSideEffects: true,
    });
    expect(index.entities["symbol:src/storage.ts#JsonStorage.save"].metadata).toMatchObject({
      role: "absorbed",
      absorbedBy: "symbol:src/storage.ts#JsonStorage",
    });
    expect(index.entities["symbol:src/storage.ts#JsonStorage.path"].metadata).toMatchObject({
      role: "absorbed",
      absorbedBy: "symbol:src/storage.ts#JsonStorage",
    });
  });
});

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-code-"));
  tempDirs.push(rootDir);

  for (const [path, text] of Object.entries(files)) {
    const absolutePath = join(rootDir, path);
    await writeFile(absolutePath, text, "utf8").catch(async (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(absolutePath, ".."), { recursive: true });
        await writeFile(absolutePath, text, "utf8");
        return;
      }

      throw error;
    });
  }

  return rootDir;
}
