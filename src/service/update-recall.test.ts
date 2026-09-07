import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildFileDag } from "../graph/file-dag.js";
import { buildCodeIndex } from "../indexer/code-indexer.js";
import { collectDependencyDocs, dependencyDocsFingerprint } from "../llm/file-pipeline.js";
import { computeBlockFingerprint } from "../markdown/block-facets.js";
import type { BlockId } from "../markdown/block-ids.js";
import type { CodeIndex, DocBlock, DocSection, ProjectIndex } from "../types.js";
import { collectDepDocStaleBlocks, collectStaleBlocks } from "./stale-detection.js";

/**
 * Update Recall: after a change, does staleness detection flag *every* doc block
 * that the change invalidated? A miss is the worst failure mode — the block stays
 * green and keeps describing old code. These tests pin a known edit to the exact
 * set of blocks that must go stale (the "golden set" is the human-known intent of
 * the edit) and assert the detector caught all of them. No LLM: detection and
 * fingerprints are deterministic AST work.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-recall-"));
  tempDirs.push(rootDir);
  for (const [path, text] of Object.entries(files)) {
    const absolutePath = join(rootDir, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }
  return rootDir;
}

// A leaf → mid → root import chain: report() calls total() calls add().
const LEAF_MID_ROOT = {
  "src/leaf.ts": ["export function add(a: number, b: number): number {", "  return a + b;", "}"].join("\n"),
  "src/mid.ts": [
    'import { add } from "./leaf.js";',
    "export function total(values: number[]): number {",
    "  return values.reduce((sum, v) => add(sum, v), 0);",
    "}",
  ].join("\n"),
  "src/root.ts": [
    'import { total } from "./mid.js";',
    "export function report(values: number[]): string {",
    '  return "Total: " + total(values);',
    "}",
  ].join("\n"),
};

function block(id: string, body: string): DocBlock {
  return { id, heading: id, depth: 3, body, rendered: true };
}

/**
 * Build a section owning one symbol, with real per-block fingerprints computed
 * from the given code index — the consistent baseline a real generation would store.
 */
function section(ownerId: string, code: CodeIndex): DocSection {
  const blocks: DocBlock[] = [
    // propagating blocks feed dependency docs; limitations is terminal (consumes them).
    block("purpose", `Purpose of ${ownerId}.`),
    block("invariants", `Invariants of ${ownerId}.`),
    block("responsibility", `Responsibility of ${ownerId}.`),
    block("limitations", `Limitations of ${ownerId}.`),
  ];
  const blockFingerprints: Record<string, string> = {};
  for (const b of blocks) {
    const fp = computeBlockFingerprint(b.id as BlockId, [ownerId], code.entities);
    if (fp) {
      blockFingerprints[b.id] = fp;
    }
  }
  const path = code.entities[ownerId].path;
  return {
    id: `sec:${ownerId}`,
    docPath: `${path.replace(/\.ts$/, "")}.codelore.md`,
    heading: ownerId,
    depth: 2,
    anchor: ownerId,
    owns: [ownerId],
    depends: [],
    usedBy: [],
    blocks,
    status: "normal",
    blockFingerprints,
    allowedBlocks: ["purpose", "invariants", "responsibility", "limitations"],
  };
}

function projectIndex(code: CodeIndex, sections: DocSection[]): ProjectIndex {
  const byId: Record<string, DocSection> = {};
  for (const s of sections) {
    byId[s.id] = s;
  }
  return {
    version: 2,
    generatedAt: "2026-07-04T00:00:00.000Z",
    code,
    docs: {
      version: 2,
      generatedAt: "2026-07-04T00:00:00.000Z",
      rootDir: code.rootDir,
      sections: byId,
      fileToSections: {},
      entityToSections: {},
    },
  };
}

function staleKeys(entries: Array<{ sectionId: string; blockId: string }>): Set<string> {
  return new Set(entries.map((e) => `${e.sectionId}/${e.blockId}`));
}

describe("Update Recall — AST facet changes flag the owning section's blocks", () => {
  it("flags every signature-tracking block when a symbol's signature changes", async () => {
    const beforeCode = await buildCodeIndex(loadConfig(await makeTempProject(LEAF_MID_ROOT)));
    const afterCode = await buildCodeIndex(
      loadConfig(
        await makeTempProject({
          ...LEAF_MID_ROOT,
          // rename params: signature facet changes for add
          "src/leaf.ts": [
            "export function add(left: number, right: number): number {",
            "  return left + right;",
            "}",
          ].join("\n"),
        })
      )
    );

    const ownerId = "symbol:src/leaf.ts#add";
    const leaf = section(ownerId, beforeCode);
    const marked = staleKeys(collectStaleBlocks([leaf], afterCode.entities));

    // purpose (signature+placement) and invariants (signature+body) both track signature.
    expect(marked.has(`${leaf.id}/purpose`)).toBe(true);
    expect(marked.has(`${leaf.id}/invariants`)).toBe(true);
  });

  it("does not flag a signature-only block when only the body changes (guards over-marking)", async () => {
    const beforeCode = await buildCodeIndex(loadConfig(await makeTempProject(LEAF_MID_ROOT)));
    const afterCode = await buildCodeIndex(
      loadConfig(
        await makeTempProject({
          ...LEAF_MID_ROOT,
          // same signature, different body
          "src/leaf.ts": ["export function add(a: number, b: number): number {", "  return b + a;", "}"].join("\n"),
        })
      )
    );

    const ownerId = "symbol:src/leaf.ts#add";
    const leaf = section(ownerId, beforeCode);
    const marked = staleKeys(collectStaleBlocks([leaf], afterCode.entities));

    // purpose tracks signature+placement — unchanged by a body edit.
    expect(marked.has(`${leaf.id}/purpose`)).toBe(false);
    // invariants tracks signature+body — the body changed, so it must flag.
    expect(marked.has(`${leaf.id}/invariants`)).toBe(true);
  });
});

describe("Update Recall — dependency-doc cascade flags importers", () => {
  it("flags the importer's terminal blocks when a dependency's doc changes", async () => {
    const code = await buildCodeIndex(loadConfig(await makeTempProject(LEAF_MID_ROOT)));

    // Sanity: root really depends on mid in the file DAG, so root consumes mid's doc.
    const dag = buildFileDag(code);
    expect([...(dag.get("src/root.ts") ?? [])]).toContain("src/mid.ts");

    const mid = section("symbol:src/mid.ts#total", code);
    const root = section("symbol:src/root.ts#report", code);

    // Stamp root with the fingerprint of its dependency docs at the consistent baseline.
    const baseIndex = projectIndex(code, [mid, root]);
    root.depDocsFingerprint = dependencyDocsFingerprint(collectDependencyDocs(baseIndex, ["src/root.ts"]));

    // No drift yet: nothing changed.
    expect(collectDepDocStaleBlocks([mid, root], baseIndex)).toHaveLength(0);

    // Change mid's doc (a propagating block) — root's dependency docs now differ.
    const midPurpose = mid.blocks.find((b) => b.id === "purpose");
    expect(midPurpose).toBeDefined();
    (midPurpose as DocBlock).body = "Rewritten purpose of total().";
    const changedIndex = projectIndex(code, [mid, root]);

    const marked = staleKeys(collectDepDocStaleBlocks([mid, root], changedIndex));
    // limitations is a terminal block (consumes dependency docs) → must flag on root.
    expect(marked.has(`${root.id}/limitations`)).toBe(true);
    // propagating blocks are generated without dependency docs → must NOT flag.
    expect(marked.has(`${root.id}/purpose`)).toBe(false);
    // The dependency's own section is not stale from its own doc edit.
    expect([...marked].some((k) => k.startsWith(`${mid.id}/`))).toBe(false);
  });
});
