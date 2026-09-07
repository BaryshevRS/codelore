import { describe, expect, it } from "vitest";
import type { BlockId } from "../markdown/block-ids.js";
import type { CodeEntity, CodeIndex, WriterBudget } from "../types.js";
import { planWriterChunks } from "./file-chunks.js";
import type { FileWriteSection } from "./file-writer.js";

const FILE = "src/big.ts";

/** charsPerToken 1 keeps the budget in char terms: maxSourceChars = maxPromptTokens − overheadChars. */
const BUDGET: WriterBudget = { maxPromptTokens: 1000, charsPerToken: 1, maxSectionsPerChunk: 6 };

function plan(args: {
  sources: Array<{ path: string; source: string }>;
  sections: FileWriteSection[];
  code: CodeIndex;
  budget?: WriterBudget;
  overheadChars?: number;
}) {
  return planWriterChunks({ budget: BUDGET, overheadChars: 0, ...args });
}

function entity(id: string, type: CodeEntity["type"], startOffset: number, endOffset: number): CodeEntity {
  return {
    id,
    type,
    path: FILE,
    name: id.split("#").at(-1) ?? id,
    signature: id,
    range: { startOffset, endOffset, startLine: 1, endLine: 1 },
    directDeps: [],
    directUsages: [],
    contentHash: "hash",
    facets: { signature: "s", body: "b", deps: "d", usage: "u", placement: "p" },
  };
}

function section(entityId: string): FileWriteSection {
  return {
    sectionId: entityId,
    heading: entityId.split("#").at(-1) ?? entityId,
    entity: { id: entityId, name: "n", type: "function", signature: "f()" },
    allowedBlocks: ["purpose"] as BlockId[],
    targetBlocks: ["purpose"] as BlockId[],
    existingBlocks: [],
    callers: [],
    dependencyEntityIds: [],
  };
}

function indexWith(entities: CodeEntity[]): CodeIndex {
  return {
    version: 1,
    generatedAt: "",
    rootDir: "/r",
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    fileToEntities: { [FILE]: entities.map((e) => e.id) },
  };
}

describe("planWriterChunks", () => {
  it("keeps small groups as a single chunk", () => {
    const source = "export function a() {}";
    const chunks = plan({
      sources: [{ path: FILE, source }],
      sections: [section("symbol:src/big.ts#a")],
      code: indexWith([entity("symbol:src/big.ts#a", "function", 0, source.length)]),
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ part: 1, parts: 1 });
    expect(chunks[0].files[0].source).toBe(source);
  });

  it("measures the comment-stripped source, so comment bulk never forces a split", () => {
    // The whole payload is comments; stripped it is a one-liner, so it must not split.
    const source = `export function a() {}\n/* ${"x".repeat(BUDGET.maxPromptTokens * 3)} */\n`;
    const chunks = plan({
      sources: [{ path: FILE, source }],
      sections: [section("symbol:src/big.ts#a")],
      code: indexWith([entity("symbol:src/big.ts#a", "function", 0, source.length)]),
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].files[0].source).not.toContain("xxxx");
  });

  it("splits an oversized file at top-level boundaries, repeats the header, drops sectionless chunks", () => {
    const header = "import { x } from './x.js';\n";
    // Real (non-comment) bulk: a string literal survives comment stripping. Each
    // function fits alone but two together exceed the budget.
    const fnBody = "y".repeat(Math.floor(BUDGET.maxPromptTokens * 0.6));
    const fn = (name: string) => `export function ${name}() { return "${fnBody}"; }\n`;
    const sourceParts = [header, fn("first"), fn("second"), fn("third")];
    const source = sourceParts.join("");
    const offsets: number[] = [];
    let cursor = header.length;
    for (const part of sourceParts.slice(1)) {
      offsets.push(cursor);
      cursor += part.length;
    }

    const entities = [
      entity("symbol:src/big.ts#first", "function", offsets[0], offsets[0] + fn("first").length),
      entity("symbol:src/big.ts#second", "function", offsets[1], offsets[1] + fn("second").length),
      entity("symbol:src/big.ts#third", "function", offsets[2], offsets[2] + fn("third").length),
    ];

    const chunks = plan({
      sources: [{ path: FILE, source }],
      sections: [section("symbol:src/big.ts#first"), section("symbol:src/big.ts#third")],
      code: indexWith(entities),
    });

    // second has no section: its chunk is dropped entirely.
    expect(chunks).toHaveLength(2);
    expect(chunks[0].parts).toBe(2);
    expect(chunks[0].sections.map((s) => s.sectionId)).toEqual(["symbol:src/big.ts#first"]);
    expect(chunks[1].sections.map((s) => s.sectionId)).toEqual(["symbol:src/big.ts#third"]);
    for (const chunk of chunks) {
      expect(chunk.files[0].source).toContain("import { x } from './x.js';");
      expect(chunk.files[0].source.length).toBeLessThan(source.length);
    }
    expect(chunks[0].files[0].source).toContain("function first");
    expect(chunks[1].files[0].source).toContain("function third");
    expect(chunks[1].files[0].source).not.toContain("function first");
  });

  it("counts the shared-prefix overhead against the budget", () => {
    const header = "import { x } from './x.js';\n";
    const fnBody = "y".repeat(Math.floor(BUDGET.maxPromptTokens * 0.6));
    const fn = (name: string) => `export function ${name}() { return "${fnBody}"; }\n`;
    const source = header + fn("only");
    const entities = [entity("symbol:src/big.ts#only", "function", header.length, source.length)];

    // Source alone fits the 1000-char budget; a large overhead shrinks it below
    // the source size, so the same input must now split.
    const roomy = plan({
      sources: [{ path: FILE, source }],
      sections: [section("symbol:src/big.ts#only")],
      code: indexWith(entities),
    });
    expect(roomy).toHaveLength(1);

    const tight = plan({
      sources: [{ path: FILE, source }],
      sections: [section("symbol:src/big.ts#only")],
      code: indexWith(entities),
      overheadChars: BUDGET.maxPromptTokens - 10,
    });
    expect(tight[0].files[0].source).toContain("function only");
  });

  it("splits a small file with many sections into section-capped calls over the same source", () => {
    const source = "export function a() {}";
    const ent = entity("symbol:src/big.ts#a", "function", 0, source.length);
    const sections = Array.from({ length: BUDGET.maxSectionsPerChunk + 2 }, (_, i) =>
      section(`symbol:src/big.ts#s${i}`)
    );

    const chunks = plan({
      sources: [{ path: FILE, source }],
      sections,
      code: indexWith([ent]),
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].sections).toHaveLength(BUDGET.maxSectionsPerChunk);
    expect(chunks[1].sections).toHaveLength(2);
    expect(chunks[0].files[0].source).toBe(source);
    expect(chunks[1].files[0].source).toBe(source);
  });

  it("keeps a class with its methods in one segment and maps method sections to it", () => {
    const classText = "export class Service { method() {} }\n";
    const helperBody = "y".repeat(BUDGET.maxPromptTokens + 200);
    const source = `${classText}export function helper() { return "${helperBody}"; }\n`;
    const entities = [
      entity("symbol:src/big.ts#Service", "class", 0, classText.length),
      entity("symbol:src/big.ts#Service.method", "method", 23, 35),
      entity("symbol:src/big.ts#helper", "function", classText.length, source.length),
    ];

    const chunks = plan({
      sources: [{ path: FILE, source }],
      sections: [section("symbol:src/big.ts#Service.method")],
      code: indexWith(entities),
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].files[0].source).toContain("class Service");
    expect(chunks[0].files[0].source).not.toContain("function helper");
    expect(chunks[0].sections.map((s) => s.sectionId)).toEqual(["symbol:src/big.ts#Service.method"]);
  });
});
