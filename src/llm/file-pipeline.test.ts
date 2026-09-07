import { describe, expect, it, vi } from "vitest";
import type { CodeIndex } from "../types.js";
import {
  buildRepairRequest,
  buildVerifySections,
  compactChunkCallers,
  fileCallerSymbolIds,
  privateHelperDepIds,
  verifyChunkFacts,
} from "./file-pipeline.js";
import type { FileWriteCaller, FileWriteResult, FileWriteSection } from "./file-writer.js";
import type { ChatCompletionInput, ChatCompletionProvider } from "./provider.js";

function caller(id: string, body: string, runtime = false): FileWriteCaller {
  return {
    id,
    path: "src/a.ts",
    signature: `function ${id}()`,
    kind: runtime ? "runtime" : "static",
    body,
    ...(runtime
      ? { runtimeEvidence: [{ literal: "event", syntaxRole: "argument", callsite: { line: 1, column: 1 } }] }
      : {}),
  };
}

function section(sectionId: string, callers: FileWriteCaller[]): FileWriteSection {
  return {
    sectionId,
    heading: sectionId,
    entity: { id: sectionId, name: sectionId, type: "function", signature: `function ${sectionId}()` },
    allowedBlocks: ["purpose"],
    targetBlocks: ["purpose"],
    existingBlocks: [],
    callers,
    dependencyEntityIds: [],
  };
}

describe("compactChunkCallers", () => {
  it("keeps all bodies when the section budget is not exceeded", () => {
    const sections = compactChunkCallers([section("s1", [caller("a", "x".repeat(3000))])]);
    expect(sections[0]?.callers[0]?.body).toBe("x".repeat(3000));
  });

  it("strips bodies over the per-section budget but keeps the caller entry", () => {
    const sections = compactChunkCallers([
      section("s1", [caller("a", "x".repeat(4000)), caller("b", "y".repeat(4000)), caller("c", "z".repeat(4000))]),
    ]);
    const callers = sections[0]?.callers ?? [];
    expect(callers.map((entry) => entry.body !== undefined)).toEqual([true, true, false]);
    expect(callers[2]).toMatchObject({ id: "c", signature: "function c()", kind: "static" });
  });

  it("gives runtime-evidence callers their body first", () => {
    const sections = compactChunkCallers([
      section("s1", [caller("a", "x".repeat(6000)), caller("b", "y".repeat(6000), true)]),
    ]);
    const callers = sections[0]?.callers ?? [];
    expect(callers.find((entry) => entry.id === "b")?.body).toBeDefined();
    expect(callers.find((entry) => entry.id === "a")?.body).toBeUndefined();
  });

  it("sends a caller body at most once across the chunk's sections", () => {
    const sections = compactChunkCallers([
      section("s1", [caller("a", "x".repeat(1000))]),
      section("s2", [caller("a", "x".repeat(1000)), caller("b", "y".repeat(1000))]),
    ]);
    expect(sections[0]?.callers[0]?.body).toBeDefined();
    expect(sections[1]?.callers.find((entry) => entry.id === "a")?.body).toBeUndefined();
    expect(sections[1]?.callers.find((entry) => entry.id === "b")?.body).toBeDefined();
  });
});

describe("buildVerifySections", () => {
  const fileSource = [
    'import { dep } from "./dep.js";',
    "",
    "export function s1() {",
    "  return helper();",
    "}",
    "",
    "function helper() {",
    "  return nested();",
    "}",
    "",
    "function nested() {",
    "  return dep();",
    "}",
    "",
    "function unrelatedHelper() {",
    "  return 'unrelated-residue';",
    "}",
    "",
    "export function s2() {",
    "  return dep();",
    "}",
    "",
  ].join("\n");
  const s1Start = fileSource.indexOf("export function s1");
  const s1End = fileSource.indexOf("}", fileSource.indexOf("return helper()")) + 1;
  const s2Start = fileSource.indexOf("export function s2");
  const s2End = fileSource.indexOf("}", fileSource.indexOf("return dep()", s2Start)) + 1;
  const code = {
    entities: {
      "symbol:src/a.ts#s1": {
        id: "symbol:src/a.ts#s1",
        path: "src/a.ts",
        range: { startOffset: s1Start, endOffset: s1End },
      },
      "symbol:src/a.ts#s2": {
        id: "symbol:src/a.ts#s2",
        path: "src/a.ts",
        range: { startOffset: s2Start, endOffset: s2End },
      },
    },
    fileToEntities: { "src/a.ts": ["file:src/a.ts", "symbol:src/a.ts#s1", "symbol:src/a.ts#s2"] },
  } as unknown as CodeIndex;
  const sources = [{ path: "src/a.ts", source: fileSource }];
  const writtenBlock = {
    text: "Текст.",
    refs: [],
    novelFact: "Текст.",
    informativeness: 0.75,
    novelty: 0.75,
    specificity: 0.75,
  };

  it("slices the entity body and appends same-file imports and private helpers", () => {
    const [verify] = buildVerifySections(
      [section("symbol:src/a.ts#s1", [])],
      { "symbol:src/a.ts#s1": { purpose: writtenBlock } },
      sources,
      code
    );

    // Entity body (the primary slice).
    expect(verify?.source).toContain("export function s1");
    expect(verify?.source).toContain("return helper()");
    // Reachable private helpers a delegated claim would rely on.
    expect(verify?.source).toContain("function helper()");
    expect(verify?.source).toContain("function nested()");
    expect(verify?.source).toContain("import { dep }");
    expect(verify?.source).not.toContain("unrelated-residue");
    expect(verify?.source).not.toContain("export function s2");
    expect(verify?.blocks).toEqual([{ blockId: "purpose", text: "Текст." }]);
  });

  it("lists every top-level declaration in the outline so existence claims are verifiable", () => {
    const [verify] = buildVerifySections(
      [section("symbol:src/a.ts#s1", [])],
      { "symbol:src/a.ts#s1": { purpose: writtenBlock } },
      sources,
      code
    );

    // `unrelatedHelper` is neither in the s1 body nor reachable from it, yet a
    // claim "defined in this file" about it must be confirmable, not flagged.
    expect(verify?.source).toContain("file outline");
    expect(verify?.source).toContain("unrelatedHelper");
    expect(verify?.source).toContain("s2");
  });

  it("keeps the outline even when the entity body fills the whole budget", () => {
    const bigBody = `export function big() {\n  return ${"x".repeat(20000)};\n}`;
    const bigSource = `${bigBody}\n\nfunction tailHelper() { return 1; }\n`;
    const bigStart = bigSource.indexOf("export function big");
    const bigEnd = bigSource.indexOf("}", bigSource.indexOf("return ")) + 1;
    const bigCode = {
      entities: {
        "symbol:src/big.ts#big": {
          id: "symbol:src/big.ts#big",
          path: "src/big.ts",
          range: { startOffset: bigStart, endOffset: bigEnd },
        },
      },
      fileToEntities: { "src/big.ts": ["file:src/big.ts", "symbol:src/big.ts#big"] },
    } as unknown as CodeIndex;

    const [verify] = buildVerifySections(
      [section("symbol:src/big.ts#big", [])],
      { "symbol:src/big.ts#big": { purpose: writtenBlock } },
      [{ path: "src/big.ts", source: bigSource }],
      bigCode
    );

    expect(verify?.source).toContain("file outline");
    expect(verify?.source).toContain("tailHelper");
  });

  it("skips sections without written blocks or without a resolvable entity", () => {
    const verifySections = buildVerifySections(
      [section("s1", []), section("s2", [])],
      { s2: { purpose: writtenBlock } },
      sources,
      code
    );

    expect(verifySections).toEqual([]);
  });

  describe("privateHelperDepIds", () => {
    const s1 = code.entities["symbol:src/a.ts#s1"];

    it("returns the entity's own reachable private helpers as synthetic ids", () => {
      const ids = privateHelperDepIds(fileSource, { path: s1.path, range: s1.range }, code);
      // s1 -> helper -> nested are reachable; the imported `dep` and the unrelated
      // sibling helper are not the entity's callees.
      expect(ids).toEqual(expect.arrayContaining(["symbol:src/a.ts#helper", "symbol:src/a.ts#nested"]));
      expect(ids).not.toContain("symbol:src/a.ts#unrelatedHelper");
      expect(ids).toHaveLength(2);
    });
  });
});

describe("fileCallerSymbolIds", () => {
  const target = { path: "src/graph/dag.ts", name: "waves" };
  const callerPath = "src/cli/render.ts";

  function callerIndex(source: string, exportedNames: string[]): CodeIndex {
    const entities: Record<string, unknown> = {};
    const ids: string[] = [`file:${callerPath}`];
    for (const name of exportedNames) {
      const start = source.indexOf(`export function ${name}`);
      const end = source.indexOf("\n}", start) + 2;
      const id = `symbol:${callerPath}#${name}`;
      entities[id] = { id, path: callerPath, range: { startOffset: start, endOffset: end } };
      ids.push(id);
    }
    return { entities, fileToEntities: { [callerPath]: ids } } as unknown as CodeIndex;
  }

  it("attributes a call inside a private helper to the indexed symbols that reach it", () => {
    const source = [
      'import { waves } from "../graph/dag.js";',
      "",
      "export function renderTree(input: string): string {",
      "  return collectNodes(input);",
      "}",
      "",
      "export function renderHtml(input: string): string {",
      "  return collectNodes(input);",
      "}",
      "",
      "export function unrelated(): number {",
      "  return 1;",
      "}",
      "",
      "function collectNodes(input: string): string {",
      "  return waves() + input;",
      "}",
      "",
    ].join("\n");
    const ids = fileCallerSymbolIds(
      source,
      callerPath,
      target,
      callerIndex(source, ["renderTree", "renderHtml", "unrelated"])
    );
    expect(ids).toEqual([`symbol:${callerPath}#renderHtml`, `symbol:${callerPath}#renderTree`]);
  });

  it("walks helper chains of arbitrary depth", () => {
    const source = [
      'import { waves } from "../graph/dag.js";',
      "",
      "export function top(): string {",
      "  return a();",
      "}",
      "",
      "function a(): string {",
      "  return b();",
      "}",
      "",
      "function b(): string {",
      "  return c();",
      "}",
      "",
      "function c(): string {",
      "  return waves();",
      "}",
      "",
    ].join("\n");
    const ids = fileCallerSymbolIds(source, callerPath, target, callerIndex(source, ["top"]));
    expect(ids).toEqual([`symbol:${callerPath}#top`]);
  });

  it("resolves aliased named imports and namespace property calls", () => {
    const source = [
      'import { waves as w } from "../graph/dag.js";',
      'import * as dag from "../graph/dag.js";',
      "",
      "export function viaAlias(): string {",
      "  return aliasHelper();",
      "}",
      "",
      "export function viaNamespace(): string {",
      "  return namespaceHelper();",
      "}",
      "",
      "function aliasHelper(): string {",
      "  return w();",
      "}",
      "",
      "function namespaceHelper(): string {",
      "  return dag.waves();",
      "}",
      "",
    ].join("\n");
    const ids = fileCallerSymbolIds(source, callerPath, target, callerIndex(source, ["viaAlias", "viaNamespace"]));
    expect(ids).toEqual([`symbol:${callerPath}#viaAlias`, `symbol:${callerPath}#viaNamespace`]);
  });

  it("ignores calls already inside indexed symbols", () => {
    const source = [
      'import { waves } from "../graph/dag.js";',
      "",
      "export function direct(): string {",
      "  return waves();",
      "}",
      "",
    ].join("\n");
    const ids = fileCallerSymbolIds(source, callerPath, target, callerIndex(source, ["direct"]));
    expect(ids).toEqual([]);
  });

  it("does not match same-name calls on unrelated objects or shadowing locals", () => {
    const source = [
      'import { other } from "../graph/dag.js";',
      "",
      "export function caller(): string {",
      "  return helper();",
      "}",
      "",
      "function helper(): string {",
      "  const obj = { waves: () => 'x' };",
      "  const waves = () => 'y';",
      "  return obj.waves() + waves();",
      "}",
      "",
    ].join("\n");
    const ids = fileCallerSymbolIds(source, callerPath, target, callerIndex(source, ["caller"]));
    expect(ids).toEqual([]);
  });

  it("does not match an import of the target name from a different module", () => {
    const source = [
      'import { waves } from "../other/module.js";',
      "",
      "export function caller(): string {",
      "  return helper();",
      "}",
      "",
      "function helper(): string {",
      "  return waves();",
      "}",
      "",
    ].join("\n");
    const ids = fileCallerSymbolIds(source, callerPath, target, callerIndex(source, ["caller"]));
    expect(ids).toEqual([]);
  });

  it("resolves nothing for module-top-level calls", () => {
    const source = ['import { waves } from "../graph/dag.js";', "", "export const RESULT = waves();", ""].join("\n");
    const ids = fileCallerSymbolIds(source, callerPath, target, {
      entities: {},
      fileToEntities: { [callerPath]: [`file:${callerPath}`] },
    } as unknown as CodeIndex);
    expect(ids).toEqual([]);
  });
});

describe("verifyChunkFacts", () => {
  const code = {
    entities: {
      s1: { id: "s1", path: "src/a.ts", range: { startOffset: 0, endOffset: 20 } },
    },
    fileToEntities: { "src/a.ts": ["s1"] },
  } as unknown as CodeIndex;
  const sources = [{ path: "src/a.ts", source: "function s1() { return all(); }" }];
  const writtenBlock = {
    text: "При пустом scope ничего не делает.",
    refs: [],
    novelFact: "Ничего не делает.",
    informativeness: 0.75,
    novelty: 0.75,
    specificity: 0.75,
  };
  const contradiction = JSON.stringify({
    contradictions: [
      { sectionId: "s1", blockId: "purpose", statement: "При пустом scope ничего не делает.", evidence: "calls all()" },
    ],
  });

  function fakeProvider(responses: string[]): ChatCompletionProvider {
    return {
      name: "fake",
      model: "fake-model",
      writerBudget: { maxPromptTokens: 100000, charsPerToken: 4, maxSectionsPerChunk: 6 },
      complete: vi.fn(async (_input: ChatCompletionInput) => {
        const next = responses.shift();
        if (next === undefined) {
          throw new Error("fake provider exhausted");
        }
        return { content: next };
      }),
    };
  }

  function args(provider: ChatCompletionProvider, result: FileWriteResult) {
    return {
      sections: [section("s1", [])],
      result,
      sources,
      code,
      rootDir: "/nonexistent",
      verifyTypeContext: false,
      dependencyDocs: [],
      groupFiles: ["src/a.ts"],
      provider,
      maxRetries: 0,
      stageSuffix: "",
      llmStages: {},
      debugSink: { writeError: vi.fn(async () => ({})) },
    };
  }

  it("drops a flagged block that the fact repair did not re-emit", async () => {
    // verification flags s1.purpose; repair answers with no blocks at all.
    const provider = fakeProvider([contradiction, '{"sections":{}}']);

    const outcome = await verifyChunkFacts(args(provider, { s1: { purpose: writtenBlock } }));

    expect(outcome.result.s1?.purpose).toBeUndefined();
    expect(outcome.remaining).toHaveLength(1);
    expect(outcome.remaining[0]).toMatchObject({ sectionId: "s1", blockId: "purpose", rule: "unsupported_claim" });
    // No recheck call: nothing was repaired.
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("keeps a repaired block when the recheck finds no contradictions", async () => {
    const repairedResponse = JSON.stringify({
      sections: {
        s1: {
          blocks: {
            purpose: {
              text: "При пустом scope вызывает all().",
              refs: [],
              novelFact: "Вызывает all().",
              informativeness: 0.75,
              novelty: 0.75,
              specificity: 0.75,
            },
          },
        },
      },
    });
    const provider = fakeProvider([contradiction, repairedResponse, '{"contradictions":[]}']);

    const outcome = await verifyChunkFacts(args(provider, { s1: { purpose: writtenBlock } }));

    expect(outcome.result.s1?.purpose?.text).toBe("При пустом scope вызывает all().");
    expect(outcome.remaining).toHaveLength(0);
    expect(provider.complete).toHaveBeenCalledTimes(3);
  });

  it("makes no LLM calls when verification finds nothing", async () => {
    const provider = fakeProvider(['{"contradictions":[]}']);

    const outcome = await verifyChunkFacts(args(provider, { s1: { purpose: writtenBlock } }));

    expect(outcome.result.s1?.purpose).toBeDefined();
    expect(outcome.factViolations).toHaveLength(0);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("routes verification and factRecheck to verifyProvider, factRepair to the writer provider", async () => {
    const repaired = JSON.stringify({
      sections: {
        s1: { blocks: { purpose: { ...writtenBlock, text: "При пустом scope вызывает all()." } } },
      },
    });
    // verifyProvider answers verification (contradiction) then recheck (clean);
    // the writer provider answers only the factRepair in between.
    const verifyProvider = fakeProvider([contradiction, '{"contradictions":[]}']);
    const writer = fakeProvider([repaired]);

    const outcome = await verifyChunkFacts({
      ...args(writer, { s1: { purpose: writtenBlock } }),
      verifyProvider,
    });

    expect(verifyProvider.complete).toHaveBeenCalledTimes(2);
    expect(writer.complete).toHaveBeenCalledTimes(1);
    expect(outcome.remaining).toHaveLength(0);
    expect(outcome.result.s1?.purpose?.text).toBe("При пустом scope вызывает all().");
  });
});

describe("buildRepairRequest", () => {
  const sections = [section("s1", [caller("a", "body")]), section("s2", [])];
  const result: FileWriteResult = {
    s1: {
      purpose: {
        text: "Does things via ghost.ts.",
        refs: ["symbol:src/ghost.ts#ghost"],
        novelFact: "Does things.",
        informativeness: 0.75,
        novelty: 0.75,
        specificity: 0.75,
      },
    },
    s2: {
      purpose: {
        text: "Fine block.",
        refs: [],
        novelFact: "Fine block.",
        informativeness: 0.5,
        novelty: 0.5,
        specificity: 0.5,
      },
    },
  };

  it("contains only the violating blocks, their violations and allowed refs — no sources", () => {
    const request = buildRepairRequest({
      sections,
      result,
      violations: [
        {
          sectionId: "s1",
          blockId: "purpose",
          rule: "unknown_ref",
          detail: 'Ref "symbol:src/ghost.ts#ghost" does not exist.',
        },
        { sectionId: "s1", blockId: "purpose", rule: "text_too_long", detail: "Too long." },
      ],
      refContext: { dependencyDocPaths: new Set(["src/dep.ts"]), groupFiles: ["src/a.ts"] },
    });

    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain('"sectionId": "s1"');
    expect(user).toContain("does not exist");
    expect(user).toContain("Too long.");
    expect(user).toContain("Does things via ghost.ts.");
    expect(user).not.toContain("Fine block.");
    expect(user).not.toContain("Source files:");
    expect(user).toContain("src/dep.ts");
    expect(
      JSON.parse(user.slice(user.indexOf("{", user.indexOf("Allowed refs")), user.indexOf("Return JSON")).trim())
    ).toEqual({
      s1: expect.arrayContaining(["a", "s1", "src/a.ts", "src/dep.ts"]),
    });
    expect(request.messages.find((message) => message.role === "system")?.content).toContain("Do not add new facts");
  });
});
