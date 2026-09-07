import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildGenerationDebugEntry,
  generationDebugEnabled,
  generationDebugPathForStatePath,
  writeGenerationDebug,
} from "./generation-debug.js";

describe("generation debug", () => {
  it("builds a file-level entry with llm stats, violations, and kept blocks", () => {
    const entry = buildGenerationDebugEntry({
      runId: "run-1",
      timestamp: "2026-06-10T00:00:00.000Z",
      command: "generate",
      provider: "test",
      model: "test-model",
      docPath: "src/pricing.codelore.md",
      files: ["src/pricing.ts"],
      sections: [
        {
          sectionId: "symbol:src/pricing.ts#buildPrice",
          heading: "buildPrice",
          entity: { id: "symbol:src/pricing.ts#buildPrice", name: "buildPrice", type: "function", signature: "f()" },
          allowedBlocks: ["purpose"],
          targetBlocks: ["purpose"],
          existingBlocks: [],
          callers: [],
          dependencyEntityIds: [],
        },
      ],
      dependencyDocs: [{ sourcePath: "src/money.ts", sections: [{ heading: "money", blocks: [] }] }],
      llmStages: {
        fileGeneration: {
          request: { messages: [{ role: "user", content: "abcd" }] },
          response: { content: "{}" },
        },
      },
      violations: [{ sectionId: "s", blockId: "purpose", rule: "unknown_ref", detail: "d" }],
      writtenBlocks: { "symbol:src/pricing.ts#buildPrice": ["purpose"] },
      keptBlocks: [{ sectionId: "s", blockId: "workflows", reason: "kept" }],
    });

    expect(entry.version).toBe(4);
    expect(entry.sections[0].targetBlocks).toEqual(["purpose"]);
    expect(entry.dependencyDocs[0].sourcePath).toBe("src/money.ts");
    expect(entry.llm.fileGeneration?.request.stats.chars).toBe(4);
    expect(entry.violations).toHaveLength(1);
    expect(entry.keptBlocks).toHaveLength(1);
  });

  it("derives the debug path from the state path", () => {
    expect(generationDebugPathForStatePath("/x/.codelore/state/src/a.codelore.json")).toBe(
      "/x/.codelore/state/src/a.codelore.generation-debug.json"
    );
  });

  it("writes nothing without CODELORE_DEBUG and writes the entry with it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codelore-debug-"));
    const statePath = join(rootDir, "state", "src", "a.codelore.json");
    const debugPath = generationDebugPathForStatePath(statePath);
    const entry = { version: 4 } as unknown as Parameters<typeof writeGenerationDebug>[0]["entry"];

    try {
      vi.stubEnv("CODELORE_DEBUG", "");
      expect(generationDebugEnabled({} as NodeJS.ProcessEnv)).toBe(false);
      await writeGenerationDebug({ statePath, entry });
      await expect(access(debugPath)).rejects.toThrow();

      vi.stubEnv("CODELORE_DEBUG", "1");
      await writeGenerationDebug({ statePath, entry });
      expect(JSON.parse(await readFile(debugPath, "utf8"))).toMatchObject({ version: 4 });
    } finally {
      vi.unstubAllEnvs();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
