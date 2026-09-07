import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBlocksAgainstDeps } from "../llm/file-pipeline.js";
import type { ChatCompletionProvider } from "../llm/provider.js";
import type { GeneratedBlock } from "../types.js";
import { CodeloreService } from "./codelore-service.js";
import { withPreservedBlockBodies } from "./prepare-docs.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function generatedBlock(text: string, score = 0.8): GeneratedBlock {
  return {
    text,
    novelFact: text.slice(0, 32),
    informativeness: score,
    novelty: score,
    specificity: score,
  };
}

describe("CodeloreService", () => {
  it("maps a diff to changed entities and affected sections", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": [
        "export function roundPrice(value: number): number { return Math.round(value); }",
        "",
        "export function buildPrice(amount: number): number {",
        "  return roundPrice(amount);",
        "}",
      ].join("\n"),
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSections([
      {
        sectionId: "symbol:src/pricing.ts#buildPrice",
        generatedBlocks: { purpose: generatedBlock("Builds the price.") },
      },
      {
        sectionId: "symbol:src/pricing.ts#roundPrice",
        generatedBlocks: { purpose: generatedBlock("Rounds the price.") },
      },
    ]);

    const diff = [
      "diff --git a/src/pricing.ts b/src/pricing.ts",
      "--- a/src/pricing.ts",
      "+++ b/src/pricing.ts",
      "@@ -3,1 +3,1 @@",
      "-export function buildPrice(amount: number): number {",
      "+export function buildPrice(amount: number): number {",
    ].join("\n");

    const analysis = await service.analyzeChange({ diff });

    expect(analysis.changedEntities).toContain("symbol:src/pricing.ts#buildPrice");
    expect(analysis.affectedSections.map((section) => section.sectionId)).toContain("symbol:src/pricing.ts#buildPrice");
  });

  it("prepares missing JSON skeletons for first-run documentation", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);

    const result = await service.prepareInitialDocs();

    expect(result.createdSections).toEqual([
      {
        entityId: "symbol:src/pricing.ts#buildPrice",
        sectionId: "symbol:src/pricing.ts#buildPrice",
        docPath: "src/pricing.codelore.md",
      },
    ]);
    expect(result.nextAction).toBe("fill_created_sections");

    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    expect(state?.sectionOrder).toEqual(["symbol:src/pricing.ts#buildPrice"]);
    const sectionState = state?.sections["symbol:src/pricing.ts#buildPrice"];
    expect(sectionState?.heading).toBe("buildPrice");
    expect(sectionState?.allowedBlocks).toContain("purpose");
    expect(Object.values(sectionState?.blocks ?? {}).every((block) => !block.rendered)).toBe(true);

    expect(await pathExists(join(rootDir, "src/pricing.codelore.md"))).toBe(false);
  });

  it("loadOrRebuildIndexes does not persist project index as a read side effect", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);

    const index = await service.loadOrRebuildIndexes();

    expect(index.code.entities["symbol:src/pricing.ts#buildPrice"]).toBeDefined();
    expect(await pathExists(join(rootDir, ".codelore/index.json"))).toBe(false);
  });

  it("rewriteSection updates the doc index incrementally without rebuilding the code index", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();

    const before = await service.loadOrRebuildIndexes();
    const codeBefore = before.code;

    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    const after = await service.loadOrRebuildIndexes();
    // Source never changed, so the code index must be the same object (no ts-morph reparse)…
    expect(after.code).toBe(codeBefore);
    // …while the doc index reflects the new block body.
    const purpose = after.docs.sections["symbol:src/pricing.ts#buildPrice"]?.blocks.find((b) => b.id === "purpose");
    expect(purpose?.body).toBe("Returns the amount unchanged.");
    // The top-level index timestamp tracks the patched docs (not left stale at build time).
    expect(after.generatedAt).toBe(after.docs.generatedAt);
  });

  it("markReviewNeeded patches the doc index without rebuilding the code index", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    const before = await service.loadOrRebuildIndexes();
    const codeBefore = before.code;

    await service.markReviewNeeded("symbol:src/pricing.ts#buildPrice", "needs a human");

    const after = await service.loadOrRebuildIndexes();
    expect(after.code).toBe(codeBefore);
    expect(after.docs.sections["symbol:src/pricing.ts#buildPrice"]?.status).toBe("review_needed");
  });

  it("merges generatedBlocks into JSON and renders rendered=true blocks into .md", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();

    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    const purpose = state?.sections["symbol:src/pricing.ts#buildPrice"]?.blocks.purpose;
    expect(purpose?.body).toBe("Returns the amount unchanged.");
    expect(purpose?.rendered).toBe(true);
    expect(purpose?.fingerprint).toMatch(/^signature=[a-f0-9]{64},placement=[a-f0-9]{64}$/);

    const md = await readFile(join(rootDir, "src/pricing.codelore.md"), "utf8");
    expect(md).toContain("## Purpose");
    expect(md).toContain("Returns the amount unchanged.");
    expect(md).not.toContain("<!--");
  });

  it("filters low-score blocks but keeps them in state with rendered=false", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();

    const result = await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: {
        purpose: generatedBlock("Returns the amount unchanged.", 0.8),
        limitations: generatedBlock("Should be changed carefully.", 0.3),
      },
      showFiltered: true,
    });

    expect(result.filteredBlocks).toEqual([
      expect.objectContaining({ blockId: "limitations", finalScore: 0.3, threshold: 0.5 }),
    ]);

    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    const limitations = state?.sections["symbol:src/pricing.ts#buildPrice"]?.blocks.limitations;
    expect(limitations?.rendered).toBe(false);

    const md = await readFile(join(rootDir, "src/pricing.codelore.md"), "utf8");
    expect(md).toContain("Returns the amount unchanged.");
    expect(md).not.toContain("Should be changed carefully.");
  });

  it("stores low-score blocks in state but excludes them from .md", async () => {
    const rootDir = await makeTempProject({
      // purpose is always-rendered by default; override it explicitly to test the filtering path.
      "codelore.config.json": JSON.stringify({ thresholds: { perBlockScore: { purpose: 0.5 } } }),
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();

    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Weak.", 0.2) },
    });

    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    const purpose = state?.sections["symbol:src/pricing.ts#buildPrice"]?.blocks.purpose;
    expect(purpose?.body).toBe("Weak.");
    expect(purpose?.rendered).toBe(false);
    expect(purpose?.scores?.informativeness).toBe(0.2);

    const md = await readFile(join(rootDir, "src/pricing.codelore.md"), "utf8");
    expect(md).not.toContain("Weak.");
  });

  it("a successful rewrite clears a review_needed status", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.markReviewNeeded("symbol:src/pricing.ts#buildPrice", "generation failed earlier");

    const before = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    expect(before?.sections["symbol:src/pricing.ts#buildPrice"]?.status).toBe("review_needed");

    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    const after = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    expect(after?.sections["symbol:src/pricing.ts#buildPrice"]?.status).toBe("normal");
  });

  it("markReviewNeeded sets section status in JSON state", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();

    await service.markReviewNeeded("symbol:src/pricing.ts#buildPrice", "ambiguous code change");

    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    expect(state?.sections["symbol:src/pricing.ts#buildPrice"]?.status).toBe("review_needed");
  });

  it("refresh_stale_docs report detects facet drift after rewrite", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: {
        purpose: generatedBlock("Purpose body."),
        workflows: generatedBlock("Workflows body."),
      },
    });

    // Change body only — workflows depends on body, purpose depends on signature+placement
    await writeFile(
      join(rootDir, "src/pricing.ts"),
      "export function buildPrice(amount: number): number { return amount + 0; }\n",
      "utf8"
    );

    const report = await service.refreshStaleDocs({ mode: "report" });
    const ids = report.stale.map((entry) => entry.blockId).sort();
    expect(ids).toContain("workflows");
    expect(ids).not.toContain("purpose");
  });

  it("refresh_stale_docs filters scope by source file path, not doc path", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
      "src/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { workflows: generatedBlock("Original pricing workflows.") },
    });
    await service.rewriteSection("symbol:src/math.ts#add", {
      generatedBlocks: { workflows: generatedBlock("Original math workflows.") },
    });

    await writeFile(
      join(rootDir, "src/pricing.ts"),
      "export function buildPrice(amount: number): number { return amount * 2; }\n",
      "utf8"
    );
    await writeFile(
      join(rootDir, "src/math.ts"),
      "export function add(a: number, b: number): number { return a + b + 0; }\n",
      "utf8"
    );

    const scoped = await service.refreshStaleDocs({ mode: "report", scope: { files: ["src/pricing.ts"] } });
    expect([...new Set(scoped.stale.map((entry) => entry.sectionId))]).toEqual(["symbol:src/pricing.ts#buildPrice"]);

    const docPathAttempt = await service.refreshStaleDocs({
      mode: "report",
      scope: { files: ["src/pricing.codelore.md"] },
    });
    expect(docPathAttempt.stale).toEqual([]);

    const byPath = await service.refreshStaleDocs({ mode: "report", scope: { paths: ["src"] } });
    expect([...new Set(byPath.stale.map((entry) => entry.sectionId))].sort()).toEqual([
      "symbol:src/math.ts#add",
      "symbol:src/pricing.ts#buildPrice",
    ]);
  });

  it("refresh_stale_docs tombstone marks stale blocks and renders callouts in .md", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { workflows: generatedBlock("Original workflows.") },
    });
    await writeFile(
      join(rootDir, "src/pricing.ts"),
      "export function buildPrice(amount: number): number { return amount * 2; }\n",
      "utf8"
    );

    const result = await service.refreshStaleDocs({ mode: "tombstone" });
    expect(result.summary.appliedTombstones).toBeGreaterThan(0);

    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    const workflows = state?.sections["symbol:src/pricing.ts#buildPrice"]?.blocks.workflows;
    expect(workflows?.staleSince).toBeTypeOf("string");
    expect(workflows?.staleReason).toBe("body_changed");
    // The body survives in the JSON state (source of truth for regeneration)…
    expect(workflows?.body).toBe("Original workflows.");

    // …but the rendered .md withholds stale content and shows only the callout.
    const md = await readFile(join(rootDir, "src/pricing.codelore.md"), "utf8");
    expect(md).toContain("⚠ Stale");
    expect(md).not.toContain("Original workflows.");
  });

  it("refresh_stale_docs merges AST and depDocs facets when both flag the same block", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { workflows: generatedBlock("Original workflows.") },
    });

    // Simulate dependency-doc drift alongside a body change.
    const stored = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    if (!stored) {
      throw new Error("missing doc state");
    }
    stored.sections["symbol:src/pricing.ts#buildPrice"].depDocsFingerprint = "outdated-fingerprint";
    await service.docStateStorage.renderAndPersist(stored);
    await writeFile(
      join(rootDir, "src/pricing.ts"),
      "export function buildPrice(amount: number): number { return amount * 2; }\n",
      "utf8"
    );

    await service.refreshStaleDocs({ mode: "tombstone" });

    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    const workflows = state?.sections["symbol:src/pricing.ts#buildPrice"]?.blocks.workflows;
    expect(workflows?.staleFacets).toEqual(expect.arrayContaining(["body", "depDocs"]));
    expect(workflows?.staleReason).toBe("code_changed");
  });

  it("verify-gate does not mark a section clean when there are no dependency docs to verify against", async () => {
    const rootDir = await makeTempProject({
      "src/leaf.ts": "export function leaf(value: number): number { return value + 1; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/leaf.ts#leaf", {
      generatedBlocks: { limitations: generatedBlock("Only handles finite numbers.") },
    });
    const index = await service.loadOrRebuildIndexes();

    let verifyCalls = 0;
    const provider: ChatCompletionProvider = {
      name: "test",
      model: "test-model",
      writerBudget: { maxPromptTokens: 100000, charsPerToken: 4, maxSectionsPerChunk: 6 },
      complete: async () => {
        verifyCalls += 1;
        throw new Error("verifier must not be consulted when there are no dependency docs");
      },
    };

    const clean = await verifyBlocksAgainstDeps({
      service,
      index,
      targets: [{ sectionId: "symbol:src/leaf.ts#leaf", blockIds: ["limitations"] }],
      provider,
    });

    // A leaf has no dependency docs, so the section cannot be confirmed clean — it must
    // fall through to regeneration, never be silently cleared.
    expect(verifyCalls).toBe(0);
    expect(clean.size).toBe(0);
  });

  it("verify-gate includes same-file private helpers but not other exported entities", async () => {
    const rootDir = await makeTempProject({
      "src/dep.ts": "export function round(value: number): number { return Math.round(value); }\n",
      "src/pricing.ts": [
        'import { round } from "./dep.js";',
        "",
        "export function buildPrice(amount: number): number {",
        "  return helper(amount);",
        "}",
        "",
        "export function unrelated(): number {",
        "  return 99;",
        "}",
        "",
        "function helper(amount: number): number {",
        "  return round(amount);",
        "}",
        "",
        "function unusedHelper(): string {",
        '  return "unrelated-private-helper";',
        "}",
      ].join("\n"),
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/dep.ts#round", {
      generatedBlocks: { purpose: generatedBlock("Rounds with Math.round.") },
    });
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { limitations: generatedBlock("Delegates rounding to helper.") },
    });
    const index = await service.loadOrRebuildIndexes();

    let verifierRequest = "";
    const provider: ChatCompletionProvider = {
      name: "test",
      model: "test-model",
      writerBudget: { maxPromptTokens: 100000, charsPerToken: 4, maxSectionsPerChunk: 6 },
      complete: async (input) => {
        verifierRequest = input.messages.find((message) => message.role === "user")?.content ?? "";
        return { content: '{"contradictions":[]}' };
      },
    };

    const clean = await verifyBlocksAgainstDeps({
      service,
      index,
      targets: [{ sectionId: "symbol:src/pricing.ts#buildPrice", blockIds: ["limitations"] }],
      provider,
    });

    expect(clean).toEqual(new Set(["symbol:src/pricing.ts#buildPrice"]));
    expect(verifierRequest).toContain('import { round } from \\"./dep.js\\"');
    expect(verifierRequest).toContain("function helper(amount: number): number");
    expect(verifierRequest).not.toContain("unrelated-private-helper");
    expect(verifierRequest).not.toContain("export function unrelated");
  });

  it("validates broken owned entities and TODO blocks", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    // Replace source so owns target disappears
    await writeFile(join(rootDir, "src/pricing.ts"), "export const noop = 1;\n", "utf8");

    const result = await service.validateDocs({ includeQuality: true });
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("stale_owned_entity");
    expect(codes).toContain("empty_required_block");
  });

  it("reports deleted owned entities as stale drift", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    await writeFile(join(rootDir, "src/pricing.ts"), "export const noop = 1;\n", "utf8");

    const report = await service.refreshStaleDocs({ mode: "report" });

    expect(report.stale).toContainEqual(
      expect.objectContaining({
        sectionId: "symbol:src/pricing.ts#buildPrice",
        blockId: "purpose",
        changedFacets: ["owned"],
        drift: "owned_entity_deleted",
      })
    );
  });

  it("includes deleted owned entities when stale report is scoped by source file or path", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    await writeFile(join(rootDir, "src/pricing.ts"), "export const noop = 1;\n", "utf8");

    const byFile = await service.refreshStaleDocs({ mode: "report", scope: { files: ["src/pricing.ts"] } });
    const byPath = await service.refreshStaleDocs({ mode: "report", scope: { paths: ["src"] } });

    for (const report of [byFile, byPath]) {
      expect(report.stale).toContainEqual(
        expect.objectContaining({
          sectionId: "symbol:src/pricing.ts#buildPrice",
          blockId: "purpose",
          changedFacets: ["owned"],
          drift: "owned_entity_deleted",
        })
      );
    }
  });

  it("generateDocsForScope prunes sections whose owned entity was deleted", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    await writeFile(join(rootDir, "src/pricing.ts"), "export const noop = 1;\n", "utf8");

    const result = await service.generateDocsForScope({ files: ["src/pricing.ts"] }, { env: {}, command: "generate" });

    // buildPrice is gone from the code, so its orphaned doc is pruned rather than
    // left as a stale callout. The file has no documentable entities left, so the
    // whole doc state is removed.
    expect(result.skipped.map((entry) => entry.sectionId)).not.toContain("symbol:src/pricing.ts#buildPrice");
    const state = await service.docStateStorage.loadDocState("src/pricing.codelore.md");
    expect(state).toBeUndefined();
  });

  it("returns section context with blocks read from state", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    const context = await service.getSectionContext("symbol:src/pricing.ts#buildPrice");
    const purpose = context.section.blocks.find((block) => block.id === "purpose");
    expect(purpose?.body).toContain("Returns the amount unchanged.");
    expect(context.targets).toEqual(context.allowedBlocks);
    expect(context.rewriteInstructions).toContain("generatedBlocks");
    expect(context.owns[0].id).toBe("symbol:src/pricing.ts#buildPrice");
  });

  it("does not expose test files as documentation usages", async () => {
    const rootDir = await makeTempProject({
      "src/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "src/app.ts": "import { add } from './math.js';\nexport function run(): number { return add(1, 2); }\n",
      "src/math.test.ts": "import { add } from './math.js';\nexport const result = add(1, 2);\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();

    const state = await service.docStateStorage.loadDocState("src/math.codelore.md");
    const section = state?.sections["symbol:src/math.ts#add"];
    expect(section?.usedBy).toEqual(["file:src/app.ts", "symbol:src/app.ts#run"]);
    expect(section?.usedBy).not.toContain("file:src/math.test.ts");

    const context = await service.getSectionContext("symbol:src/math.ts#add");
    expect(context.section.usedBy).toEqual(["file:src/app.ts", "symbol:src/app.ts#run"]);
    expect(context.directUsages.map((usage) => usage.id)).toEqual(["file:src/app.ts", "symbol:src/app.ts#run"]);
  });

  it("getSectionContext respects an explicit targets list", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();

    const context = await service.getSectionContext("symbol:src/pricing.ts#buildPrice", undefined, {
      targets: ["purpose"],
    });
    expect(context.targets).toEqual(["purpose"]);
    expect(context.allowedBlocks).toContain("purpose");
    expect(context.rewriteInstructions).toContain("Generate ONLY these target block ids");
  });

  it("keeps source extension when colocated doc names collide", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.js": "export function buildJs() { return 1; }\n",
      "src/pricing.ts": "export function buildTs(): number { return 1; }\n",
    });
    const service = new CodeloreService(rootDir);

    const result = await service.prepareInitialDocs();
    expect(result.createdSections.map((s) => s.docPath).sort()).toEqual([
      "src/pricing.js.codelore.md",
      "src/pricing.ts.codelore.md",
    ]);
  });

  it("creates scoped initial docs and ignores out-of-scope sources", async () => {
    const rootDir = await makeTempProject({
      "src/checkout/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
      "src/orders/order.ts": "export function submitOrder(): string { return 'ok'; }\n",
    });
    const service = new CodeloreService(rootDir);

    const result = await service.prepareInitialDocs({ paths: ["src/checkout"] });

    expect(result.createdSections).toEqual([
      {
        entityId: "symbol:src/checkout/pricing.ts#buildPrice",
        sectionId: "symbol:src/checkout/pricing.ts#buildPrice",
        docPath: "src/checkout/pricing.codelore.md",
      },
    ]);
    const orderState = await service.docStateStorage.loadDocState("src/orders/order.codelore.md");
    expect(orderState).toBeUndefined();
  });

  it("dryRun prepareInitialDocs does not create JSON state or .md", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);

    const result = await service.prepareInitialDocs({ dryRun: true });
    expect(result.nextAction).toBe("run_without_dry_run");
    expect(result.createdSections).toEqual([]);
    expect(await service.docStateStorage.loadDocState("src/pricing.codelore.md")).toBeUndefined();
  });

  it("re-renders docs when only config thresholds change, no LLM", async () => {
    const rootDir = await makeTempProject({
      // purpose is always-rendered by default; override explicitly to exercise threshold-driven filtering.
      "codelore.config.json": JSON.stringify({ thresholds: { minScore: 0.7, perBlockScore: { purpose: 0.7 } } }),
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.", 0.5) },
    });

    const docPath = join(rootDir, "src/pricing.codelore.md");
    let md = await readFile(docPath, "utf8");
    expect(md).not.toContain("Returns the amount unchanged.");

    // Lower the threshold and trigger a rebuild (no rewrite_section, no LLM).
    await writeFile(
      join(rootDir, "codelore.config.json"),
      JSON.stringify({ thresholds: { minScore: 0.3, perBlockScore: { purpose: 0.3 } } }),
      "utf8"
    );
    const reopened = new CodeloreService(rootDir);
    await reopened.rebuildIndex();

    md = await readFile(docPath, "utf8");
    expect(md).toContain("Returns the amount unchanged.");
  });

  it("rebuildIndex is idempotent when config does not change", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rewriteSection("symbol:src/pricing.ts#buildPrice", {
      generatedBlocks: { purpose: generatedBlock("Returns the amount unchanged.") },
    });

    const before = (await readFile(join(rootDir, ".codelore/state/src/pricing.codelore.json"), "utf8")).toString();
    await service.rebuildIndex();
    await service.rebuildIndex();
    const after = (await readFile(join(rootDir, ".codelore/state/src/pricing.codelore.json"), "utf8")).toString();
    expect(after).toBe(before);
  });

  it("builds project context from the global writing rules only (terms are resolved per file group)", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        docs: {
          language: "ru",
          translations: ["en"],
          writingRules: ["Голос сухой.", "Без воды."],
          terms: [{ ru: ["блок", "секция", "stale"] }],
        },
      }),
    });
    const service = new CodeloreService(rootDir);

    const ctx = await service.getProjectContext();
    expect(ctx).toEqual({
      text: "- Голос сухой.\n- Без воды.",
      sources: ["codelore.config.json:docs.writingRules"],
    });
  });
});

describe("withPreservedBlockBodies", () => {
  it("keeps non-empty blocks from the previous section when the skeleton would blank them", () => {
    const previous = sectionFixture({
      purpose: { body: "Складывает числа.", rendered: true, fingerprint: "old" },
      workflows: { body: "", rendered: false },
    });
    const fresh = sectionFixture({
      purpose: { body: "", rendered: false, fingerprint: "new" },
      invariants: { body: "", rendered: false },
    });

    const merged = withPreservedBlockBodies(previous, fresh);
    expect(merged.blocks.purpose?.body).toBe("Складывает числа.");
    expect(merged.blocks.purpose?.fingerprint).toBe("old");
    expect(merged.blocks.invariants?.body).toBe("");
    expect(merged.blocks.workflows).toBeUndefined();
  });

  it("does not resurrect previous text over a freshly written block", () => {
    const previous = sectionFixture({ purpose: { body: "старый", rendered: true } });
    const fresh = sectionFixture({ purpose: { body: "новый", rendered: true } });
    expect(withPreservedBlockBodies(previous, fresh).blocks.purpose?.body).toBe("новый");
  });
});

function sectionFixture(blocks: Record<string, { body: string; rendered: boolean; fingerprint?: string }>) {
  return {
    heading: "h",
    depth: 1 as const,
    anchor: "h",
    owns: ["symbol:a.ts#fn"],
    depends: [],
    usedBy: [],
    status: "normal" as const,
    allowedBlocks: Object.keys(blocks) as never[],
    blockOrder: Object.keys(blocks) as never[],
    blocks: blocks as never,
  };
}

describe("loadOrRebuildIndexes", () => {
  it("rebuilds instead of trusting a persisted index older than the doc state", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rebuildIndexes({ persist: true });

    const indexPath = join(rootDir, ".codelore", "index.json");
    const persisted = JSON.parse(await readFile(indexPath, "utf8"));
    persisted.generatedAt = new Date(0).toISOString();
    persisted.docs = { ...persisted.docs, sections: {} };
    await writeFile(indexPath, JSON.stringify(persisted), "utf8");

    const coldService = new CodeloreService(rootDir);
    const index = await coldService.loadOrRebuildIndexes();

    expect(Object.keys(index.docs.sections)).toContain("symbol:src/pricing.ts#buildPrice");
  });

  it("uses the persisted index when nothing changed after it was generated", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": "export function buildPrice(amount: number): number { return amount; }\n",
    });
    const service = new CodeloreService(rootDir);
    await service.prepareInitialDocs();
    await service.rebuildIndexes({ persist: true });

    const indexPath = join(rootDir, ".codelore", "index.json");
    const persisted = JSON.parse(await readFile(indexPath, "utf8"));
    persisted.generatedAt = new Date(Date.now() + 60_000).toISOString();
    persisted.docs = {
      ...persisted.docs,
      sections: { sentinel: persisted.docs.sections[Object.keys(persisted.docs.sections)[0]] },
    };
    await writeFile(indexPath, JSON.stringify(persisted), "utf8");

    const coldService = new CodeloreService(rootDir);
    const index = await coldService.loadOrRebuildIndexes();

    expect(Object.keys(index.docs.sections)).toEqual(["sentinel"]);
  });
});

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-service-"));
  tempDirs.push(rootDir);
  for (const [path, text] of Object.entries(files)) {
    const absolutePath = join(rootDir, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }
  return rootDir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
