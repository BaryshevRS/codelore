import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOC_STATE_VERSION } from "../storage/doc-state-storage.js";
import { runCli } from "./run-cli.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TEST_LLM_CONFIG = {
  llm: {
    provider: "test",
    providers: {
      test: {
        type: "openai-compatible",
        baseUrl: "https://example.test/v1/",
        model: "test-model",
        apiKey: "test-key",
      },
    },
  },
};

describe("runCli", () => {
  it("exits 2 when validate-docs finds issues and 0 when the docs are clean", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/pricing.ts": ["export function buildPrice(amount: number): number {", "  return amount;", "}"].join("\n"),
    });
    const statePath = join(rootDir, ".codelore/state/src/pricing.codelore.json");
    await mkdir(join(rootDir, ".codelore/state/src"), { recursive: true });
    const state = {
      version: DOC_STATE_VERSION,
      docPath: "src/pricing.codelore.md",
      generatedAt: "2026-07-04T00:00:00.000Z",
      sectionOrder: ["symbol:src/pricing.ts#buildPrice"],
      sections: {
        "symbol:src/pricing.ts#buildPrice": {
          heading: "buildPrice",
          depth: 2,
          anchor: "buildprice",
          owns: ["symbol:src/pricing.ts#buildPrice"],
          depends: [],
          usedBy: [],
          status: "normal",
          allowedBlocks: ["purpose"],
          blockOrder: ["purpose"],
          blocks: { purpose: { body: "TODO", rendered: true } },
        },
      },
    };
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const stdout = buffer();
    const dirty = await runCli(["--root", rootDir, "validate-docs", "--quality"], {
      cwd: rootDir,
      env: {},
      stdout,
      stderr: buffer(),
    });

    expect(dirty).toBe(2);
    expect(stdout.text).toContain("still TODO");

    state.sections["symbol:src/pricing.ts#buildPrice"].blocks.purpose.body = "Returns the amount unchanged.";
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const clean = await runCli(["--root", rootDir, "validate-docs", "--quality"], {
      cwd: rootDir,
      env: {},
      stdout: buffer(),
      stderr: buffer(),
    });

    expect(clean).toBe(0);
  });

  it("prepares and fills created sections through the configured provider", async () => {
    // Generation debug dumps are opt-in; this test reads one, so it asks for them.
    vi.stubEnv("CODELORE_DEBUG", "1");
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/pricing.ts": [
        "export function buildPrice(amount: number): number {",
        "  return Math.round(amount);",
        "}",
      ].join("\n"),
    });
    const stdout = buffer();
    const stderr = buffer();
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];

    const exitCode = await runCli(["--root", rootDir, "prepare-initial-docs", "--fill"], {
      cwd: rootDir,
      env: {},
      stdout,
      stderr,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return llmResponse(
          writerReply("symbol:src/pricing.ts#buildPrice", init, {
            purpose: block("Rounds the input amount into a price value."),
            responsibility: block("Owns only the rounding step for price construction."),
          })
        );
      }) as typeof fetch,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text).toBe("");
    // Two phases (propagating, terminal), each a writer call plus its fact-check verification.
    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      url: "https://example.test/v1/chat/completions",
      authorization: "Bearer test-key",
    });
    expect(requests[0].body).toMatchObject({ model: "test-model" });

    const output = JSON.parse(stdout.text);
    expect(output).toMatchObject({
      provider: "test",
      model: "test-model",
      updatedSections: [
        expect.objectContaining({
          sectionId: "symbol:src/pricing.ts#buildPrice",
          generationDebugPath: expect.any(String),
        }),
      ],
    });
    await expect(readFile(join(rootDir, "src/pricing.codelore.md"), "utf8")).resolves.toContain(
      "Rounds the input amount into a price value."
    );
    const state = JSON.parse(await readFile(join(rootDir, ".codelore/state/src/pricing.codelore.json"), "utf8"));
    expect(Object.keys(state.sections)).toContain("symbol:src/pricing.ts#buildPrice");
    // One history entry per phase; the propagating one carries purpose/responsibility.
    expect(state.sections["symbol:src/pricing.ts#buildPrice"].generationHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "prepare-initial-docs --fill",
          provider: "test",
          model: "test-model",
          generatedBlocks: expect.arrayContaining(["purpose", "responsibility"]),
        }),
      ])
    );
    expect(state.sections["symbol:src/pricing.ts#buildPrice"].depDocsFingerprint).toEqual(expect.any(String));

    // Each phase writes its own debug file; the propagating one carries the P/R/I trace.
    const propagatingDebugPath = join(
      rootDir,
      ".codelore/state/src/pricing.codelore.generation-debug.propagating.json"
    );
    const debug = JSON.parse(await readFile(propagatingDebugPath, "utf8"));
    expect(debug).toMatchObject({
      version: 4,
      command: "prepare-initial-docs --fill",
      provider: "test",
      model: "test-model",
      docPath: "src/pricing.codelore.md",
      files: ["src/pricing.ts"],
      sections: [
        expect.objectContaining({
          sectionId: "symbol:src/pricing.ts#buildPrice",
          targetBlocks: expect.arrayContaining(["purpose", "responsibility"]),
        }),
      ],
      llm: {
        fileGeneration: {
          request: {
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                content: expect.stringContaining("--- src/pricing.ts ---"),
                stats: expect.objectContaining({ chars: expect.any(Number), approxTokens: expect.any(Number) }),
              }),
            ]),
            stats: expect.objectContaining({ chars: expect.any(Number) }),
          },
          response: {
            content: expect.stringContaining("Rounds the input amount into a price value."),
            stats: expect.objectContaining({ chars: expect.any(Number) }),
          },
        },
      },
      writtenBlocks: {
        "symbol:src/pricing.ts#buildPrice": expect.arrayContaining(["purpose", "responsibility"]),
      },
    });
  });

  it("generate fills new skeletons and refills tombstoned sections in one run", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/pricing.ts": [
        "export function buildPrice(amount: number): number {",
        "  return Math.round(amount);",
        "}",
      ].join("\n"),
    });
    const stdout = buffer();
    const stderr = buffer();
    let calls = 0;
    let markdownExistedBeforeFirstLlmCall: boolean | undefined;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (calls === 0) {
        markdownExistedBeforeFirstLlmCall = await pathExists(join(rootDir, "src/pricing.codelore.md"));
      }
      calls += 1;
      return llmResponse(
        writerReply("symbol:src/pricing.ts#buildPrice", init, { purpose: block("Generated purpose.") })
      );
    }) as typeof fetch;

    const firstExit = await runCli(["--root", rootDir, "generate"], {
      cwd: rootDir,
      env: {},
      stdout,
      stderr,
      fetch: fetchMock,
    });
    expect(firstExit).toBe(0);
    expect(stderr.text).toBe("");
    // Two phases, each a writer call plus its fact-check verification.
    expect(calls).toBe(4);
    expect(markdownExistedBeforeFirstLlmCall).toBe(false);
    const firstOutput = JSON.parse(stdout.text);
    expect(firstOutput.updatedSections).toHaveLength(1);
    expect(firstOutput.updatedSections[0].sectionId).toBe("symbol:src/pricing.ts#buildPrice");

    await writeFile(
      join(rootDir, "src/pricing.ts"),
      [
        "export function buildPrice(amount: number, factor: number): number {",
        "  return Math.round(amount * factor);",
        "}",
      ].join("\n"),
      "utf8"
    );

    const stdout2 = buffer();
    const stderr2 = buffer();
    const secondExit = await runCli(["--root", rootDir, "generate"], {
      cwd: rootDir,
      env: {},
      stdout: stdout2,
      stderr: stderr2,
      fetch: fetchMock,
    });
    expect(secondExit).toBe(0);
    expect(stderr2.text).toBe("");
    // The second run re-tombstones the changed file and refills it across both phases.
    expect(calls).toBe(8);
    const secondOutput = JSON.parse(stdout2.text);
    expect(secondOutput.updatedSections.length).toBeGreaterThan(0);
    expect(secondOutput.updatedSections[0].sectionId).toBe("symbol:src/pricing.ts#buildPrice");
    await expect(readFile(join(rootDir, "src/pricing.codelore.md"), "utf8")).resolves.toContain("Generated purpose.");
  });

  it("generate --force regenerates fresh blocks and clears a review_needed section", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/pricing.ts": ["export function buildPrice(amount: number): number {", "  return amount;", "}"].join("\n"),
    });
    const sectionId = "symbol:src/pricing.ts#buildPrice";
    const statePath = join(rootDir, ".codelore/state/src/pricing.codelore.json");
    const runtime = (stdout: ReturnType<typeof buffer>) => ({
      cwd: rootDir,
      env: {},
      stdout,
      stderr: buffer(),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        llmResponse(writerReply(sectionId, init))) as typeof fetch,
    });

    await runCli(["--root", rootDir, "generate"], runtime(buffer()));

    // Mark it review_needed without touching the (now fresh) blocks.
    await runCli(["--root", rootDir, "mark-review-needed", sectionId, "--reason", "manual"], runtime(buffer()));
    const marked = JSON.parse(await readFile(statePath, "utf8"));
    expect(marked.sections[sectionId].status).toBe("review_needed");
    expect(marked.sections[sectionId].blocks.purpose.staleSince).toBeUndefined();

    // Plain generate has no stale block to target, so it cannot clear the status.
    const plain = buffer();
    await runCli(["--root", rootDir, "generate", "--entity", sectionId], runtime(plain));
    expect(JSON.parse(await readFile(statePath, "utf8")).sections[sectionId].status).toBe("review_needed");

    // --force regenerates every allowed block, so the write path clears review.
    await runCli(["--root", rootDir, "generate", "--entity", sectionId, "--force"], runtime(buffer()));
    expect(JSON.parse(await readFile(statePath, "utf8")).sections[sectionId].status).toBe("normal");
  });

  it("generates propagating blocks without dep docs, then feeds them to dependents' terminal blocks", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/util.ts": [
        "// stale comment: helper divides the value",
        "export function helper(value: number): number {",
        "  return value * 2;",
        "}",
      ].join("\n"),
      "src/app.ts": [
        "import { helper } from './util.js';",
        "",
        "export function run(value: number): number {",
        "  return helper(value) + 1;",
        "}",
      ].join("\n"),
    });
    const stdout = buffer();
    const stderr = buffer();
    const prompts: string[] = [];

    const exitCode = await runCli(["--root", rootDir, "generate"], {
      cwd: rootDir,
      env: {},
      stdout,
      stderr,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
        prompts.push(prompt);
        if (prompt.includes("--- src/util.ts ---")) {
          return llmResponse(
            writerReply("symbol:src/util.ts#helper", init, { purpose: block("Doubles the given number.") })
          );
        }
        return llmResponse(
          writerReply("symbol:src/app.ts#run", init, { purpose: block("Builds the final value on top of helper.") })
        );
      }) as typeof fetch,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text).toBe("");
    const writerPrompts = prompts.filter((prompt) => prompt.includes("Source files:"));
    // Two files × two phases (propagating, terminal).
    expect(writerPrompts).toHaveLength(4);

    const appPrompts = writerPrompts.filter((prompt) => prompt.includes("--- src/app.ts ---"));
    const appPropagating = appPrompts.find((prompt) => !prompt.includes("Dependency docs"));
    const appTerminal = appPrompts.find((prompt) => prompt.includes("Dependency docs"));

    // Propagating blocks are written from the file's own code, with no dependency docs.
    expect(appPropagating).toBeDefined();
    expect(appPropagating).not.toContain("Doubles the given number.");
    // The dependent's terminal blocks see the leaf's finished propagating docs.
    expect(appTerminal).toContain("Doubles the given number.");

    // The leaf's writer sees its caller from the dependent file (code-level context).
    expect(
      writerPrompts.some((prompt) => prompt.includes("--- src/util.ts ---") && prompt.includes("symbol:src/app.ts#run"))
    ).toBe(true);

    // Comments never reach the LLM: they are unverified prose that rots.
    for (const prompt of prompts) {
      expect(prompt).not.toContain("stale comment");
    }

    await expect(readFile(join(rootDir, "src/util.codelore.md"), "utf8")).resolves.toContain(
      "Doubles the given number."
    );
    await expect(readFile(join(rootDir, "src/app.codelore.md"), "utf8")).resolves.toContain(
      "Builds the final value on top of helper."
    );
  });

  it("fix-stale converges the in-scope cascade in one run, leaving nothing stale", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/util.ts": "export function helper(value: number): number { return value * 2; }\n",
      "src/app.ts": [
        "import { helper } from './util.js';",
        "export function run(value: number): number { return helper(value) + 1; }",
      ].join("\n"),
    });
    const writerMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = userPrompt(init);
      if (targetBlocksFromPrompt(prompt).length > 0) {
        const sectionId = prompt.includes("--- src/util.ts ---")
          ? "symbol:src/util.ts#helper"
          : "symbol:src/app.ts#run";
        return llmResponse(writerReply(sectionId, init));
      }
      return llmResponse(JSON.stringify({ contradictions: [] }));
    }) as typeof fetch;

    expect(
      await runCli(["--root", rootDir, "generate"], {
        cwd: rootDir,
        env: {},
        stdout: buffer(),
        stderr: buffer(),
        fetch: writerMock,
      })
    ).toBe(0);

    // Change the leaf's code: its propagating doc regenerates, which re-drifts the
    // dependent's depDocs — the cascade a single run must resolve on its own.
    await writeFile(
      join(rootDir, "src/util.ts"),
      "export function helper(value: number): number { return value * 3; }\n",
      "utf8"
    );

    const out = buffer();
    const err = buffer();
    const fixExit = await runCli(["--root", rootDir, "fix-stale", "--path", "src"], {
      cwd: rootDir,
      env: {},
      stdout: out,
      stderr: err,
      fetch: writerMock,
    });
    expect(err.text).toBe("");
    expect(fixExit).toBe(0);

    // One fix-stale run must leave the scope fully documented — no residual stale.
    const reportOut = buffer();
    await runCli(["--root", rootDir, "refresh-stale-docs", "--mode", "report", "--path", "src"], {
      cwd: rootDir,
      env: {},
      stdout: reportOut,
      stderr: buffer(),
      fetch: (async () => {
        throw new Error("report must not call the LLM");
      }) as typeof fetch,
    });
    expect(JSON.parse(reportOut.text).stale).toEqual([]);
  });

  it("records depDocs fingerprints for an import-cycle group that refresh-stale recomputes to the same value", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/a.ts": [
        "import { b } from './b.js';",
        "",
        "export function a(flag: boolean): number {",
        "  return flag ? b(false) + 1 : 0;",
        "}",
      ].join("\n"),
      "src/b.ts": [
        "import { a } from './a.js';",
        "",
        "export function b(flag: boolean): number {",
        "  return flag ? a(false) - 1 : 0;",
        "}",
      ].join("\n"),
    });
    const stdout = buffer();
    const stderr = buffer();
    const exitCode = await runCli(["--root", rootDir, "generate"], {
      cwd: rootDir,
      env: {},
      stdout,
      stderr,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
        const sectionId = prompt.includes("--- src/a.ts ---") ? "symbol:src/a.ts#a" : "symbol:src/b.ts#b";
        return llmResponse(writerReply(sectionId, init));
      }) as typeof fetch,
    });
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text).failed).toEqual([]);
    expect(exitCode).toBe(0);

    // No code or dependency docs changed since generation: nothing may be stale.
    const refreshOut = buffer();
    const refreshErr = buffer();
    const refreshExit = await runCli(["--root", rootDir, "refresh-stale-docs", "--mode", "report"], {
      cwd: rootDir,
      env: {},
      stdout: refreshOut,
      stderr: refreshErr,
      fetch: (async () => {
        throw new Error("refresh-stale-docs must not call the LLM");
      }) as typeof fetch,
    });
    expect(refreshExit).toBe(0);
    expect(refreshErr.text).toBe("");
    const report = JSON.parse(refreshOut.text);
    expect(report.stale).toEqual([]);
  });

  it("verify-gate clears a dependent on a cosmetic dependency-doc change without regenerating it", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/util.ts": "export function helper(value: number): number { return value * 2; }\n",
      "src/app.ts": [
        "import { helper } from './util.js';",
        "export function run(value: number): number { return helper(value) + 1; }",
      ].join("\n"),
    });

    // Cold generate both docs.
    const cold = await runCli(["--root", rootDir, "generate"], {
      cwd: rootDir,
      env: {},
      stdout: buffer(),
      stderr: buffer(),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const prompt = userPrompt(init);
        const sectionId = prompt.includes("--- src/util.ts ---")
          ? "symbol:src/util.ts#helper"
          : "symbol:src/app.ts#run";
        return llmResponse(writerReply(sectionId, init));
      }) as typeof fetch,
    });
    expect(cold).toBe(0);

    // Cosmetically change the dependency's (util) purpose doc so app's depDocs drift,
    // without touching app's own code — the depDocs-only cascade.
    const utilStatePath = join(rootDir, ".codelore/state/src/util.codelore.json");
    const utilState = JSON.parse(await readFile(utilStatePath, "utf8"));
    utilState.sections["symbol:src/util.ts#helper"].blocks.purpose.body = "Doubles the value (reworded).";
    await writeFile(utilStatePath, JSON.stringify(utilState), "utf8");

    // fix-stale: app is flagged depDocs-only; the verifier finds no contradiction, so
    // app must NOT be regenerated — only fingerprint-refreshed.
    const out = buffer();
    const err = buffer();
    let verifyCalls = 0;
    let writerForApp = false;
    const code = await runCli(["--root", rootDir, "fix-stale"], {
      cwd: rootDir,
      env: {},
      stdout: out,
      stderr: err,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const prompt = userPrompt(init);
        if (targetBlocksFromPrompt(prompt).length > 0) {
          if (prompt.includes("--- src/app.ts ---")) {
            writerForApp = true;
          }
          const sectionId = prompt.includes("--- src/util.ts ---")
            ? "symbol:src/util.ts#helper"
            : "symbol:src/app.ts#run";
          return llmResponse(writerReply(sectionId, init));
        }
        // Verify request (no targetBlocks): no contradiction.
        verifyCalls += 1;
        return llmResponse(JSON.stringify({ contradictions: [] }));
      }) as typeof fetch,
    });
    expect(err.text).toBe("");
    expect(code).toBe(0);
    // The gate verified app's existing text and found it still correct…
    expect(verifyCalls).toBeGreaterThan(0);
    // …so app was never regenerated.
    expect(writerForApp).toBe(false);
    expect(JSON.parse(out.text).updatedSections).toEqual([]);

    // And the section is no longer stale (fingerprint was refreshed, not left drifting).
    const reportOut = buffer();
    await runCli(["--root", rootDir, "refresh-stale-docs", "--mode", "report"], {
      cwd: rootDir,
      env: {},
      stdout: reportOut,
      stderr: buffer(),
      fetch: (async () => {
        throw new Error("report must not call the LLM");
      }) as typeof fetch,
    });
    expect(JSON.parse(reportOut.text).stale).toEqual([]);
  });

  it("fix-stale regenerates only stale terminal blocks for depDocs drift", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/util.ts": "export function helper(value: number): number { return value * 2; }\n",
      "src/app.ts": [
        "import { helper } from './util.js';",
        "export function run(value: number): number { return helper(value) + 1; }",
      ].join("\n"),
    });

    const cold = await runCli(["--root", rootDir, "generate"], {
      cwd: rootDir,
      env: {},
      stdout: buffer(),
      stderr: buffer(),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const prompt = userPrompt(init);
        const sectionId = prompt.includes("--- src/util.ts ---")
          ? "symbol:src/util.ts#helper"
          : "symbol:src/app.ts#run";
        return llmResponse(writerReply(sectionId, init));
      }) as typeof fetch,
    });
    expect(cold).toBe(0);

    const utilStatePath = join(rootDir, ".codelore/state/src/util.codelore.json");
    const utilState = JSON.parse(await readFile(utilStatePath, "utf8"));
    utilState.sections["symbol:src/util.ts#helper"].blocks.purpose.body = "Triples the value.";
    await writeFile(utilStatePath, JSON.stringify(utilState), "utf8");

    let gateAnswered = false;
    const appWriterTargetBlocks: string[][] = [];
    const out = buffer();
    const err = buffer();
    const code = await runCli(["--root", rootDir, "fix-stale"], {
      cwd: rootDir,
      env: {},
      stdout: out,
      stderr: err,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const prompt = userPrompt(init);
        const targets = targetBlocksFromPrompt(prompt);
        if (targets.length === 0) {
          if (!gateAnswered) {
            gateAnswered = true;
            return llmResponse(
              JSON.stringify({
                contradictions: [
                  {
                    sectionId: "symbol:src/app.ts#run",
                    blockId: "limitations",
                    statement: "Generated limitations.",
                    evidence: "helper documentation changed materially.",
                  },
                ],
              })
            );
          }
          return llmResponse(JSON.stringify({ contradictions: [] }));
        }
        if (prompt.includes("--- src/app.ts ---")) {
          appWriterTargetBlocks.push(targets);
        }
        return llmResponse(writerReply("symbol:src/app.ts#run", init));
      }) as typeof fetch,
    });

    expect(err.text).toBe("");
    expect(code).toBe(0);
    expect(gateAnswered).toBe(true);
    expect(appWriterTargetBlocks.length).toBeGreaterThan(0);
    expect(appWriterTargetBlocks.flat()).not.toEqual(
      expect.arrayContaining(["purpose", "responsibility", "invariants"])
    );
    expect(appWriterTargetBlocks.flat()).toEqual(expect.arrayContaining(["limitations"]));
  });

  it("rejects stray positional arguments instead of running an unscoped command", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/pricing.ts": "export function buildPrice(a: number): number { return a; }",
    });
    let calls = 0;
    const stderr = buffer();
    const exitCode = await runCli(["--root", rootDir, "generate", "graph"], {
      cwd: rootDir,
      env: {},
      stdout: buffer(),
      stderr,
      fetch: (async () => {
        calls += 1;
        return llmResponse("{}");
      }) as typeof fetch,
    });
    expect(exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(stderr.text).toContain('Unexpected argument \\"graph\\" for command \\"generate\\"');

    const unknownOption = buffer();
    const unknownExit = await runCli(["--root", rootDir, "generate", "--paht", "src"], {
      cwd: rootDir,
      env: {},
      stdout: buffer(),
      stderr: unknownOption,
      fetch: (async () => llmResponse("{}")) as typeof fetch,
    });
    expect(unknownExit).toBe(1);
    expect(unknownOption.text).toContain('Unknown option \\"--paht\\"');
  });

  it("does not tombstone docs outside an empty scope", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify(TEST_LLM_CONFIG),
      "src/pricing.ts": [
        "export function buildPrice(amount: number): number {",
        "  return Math.round(amount);",
        "}",
      ].join("\n"),
      // Entry-point file: no page-worthy entities, so the scoped prepare yields nothing.
      "src/bin/cli.ts": ["import { buildPrice } from '../pricing.js';", "console.log(buildPrice(1));"].join("\n"),
    });
    let calls = 0;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return llmResponse(writerReply("symbol:src/pricing.ts#buildPrice", init));
    }) as typeof fetch;

    const firstExit = await runCli(["--root", rootDir, "generate", "--file", "src/pricing.ts"], {
      cwd: rootDir,
      env: {},
      stdout: buffer(),
      stderr: buffer(),
      fetch: fetchMock,
    });
    expect(firstExit).toBe(0);
    // One file, two phases: each a writer call plus its fact-check verification.
    expect(calls).toBe(4);

    // Make pricing stale, then generate a scope that matches no sections:
    // the stale pricing doc must NOT be regenerated.
    await writeFile(
      join(rootDir, "src/pricing.ts"),
      [
        "export function buildPrice(amount: number, factor: number): number {",
        "  return Math.round(amount * factor);",
        "}",
      ].join("\n"),
      "utf8"
    );
    const stdout = buffer();
    const exitCode = await runCli(["--root", rootDir, "generate", "--path", "src/bin"], {
      cwd: rootDir,
      env: {},
      stdout,
      stderr: buffer(),
      fetch: fetchMock,
    });
    expect(exitCode).toBe(0);
    expect(calls).toBe(4);
    expect(JSON.parse(stdout.text).updatedSections).toEqual([]);
  });

  it("keeps low-scored blocks in state without rendering them", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        // purpose is always-rendered by default; override explicitly to drive the score-based filter.
        thresholds: { perBlockScore: { purpose: 0.5 } },
        ...TEST_LLM_CONFIG,
      }),
      "src/pricing.ts": [
        "export function buildPrice(amount: number): number {",
        "  return Math.round(amount);",
        "}",
      ].join("\n"),
    });
    const stdout = buffer();
    const stderr = buffer();

    const exitCode = await runCli(["--root", rootDir, "generate"], {
      cwd: rootDir,
      env: {},
      stdout,
      stderr,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        llmResponse(
          writerReply("symbol:src/pricing.ts#buildPrice", init, {
            purpose: block("Low value purpose text.", { informativeness: 0.25, novelty: 0.25, specificity: 0.25 }),
            responsibility: block("Owns only the rounding step."),
          })
        )) as typeof fetch,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text).toBe("");
    const state = JSON.parse(await readFile(join(rootDir, ".codelore/state/src/pricing.codelore.json"), "utf8"));
    const blocks = state.sections["symbol:src/pricing.ts#buildPrice"].blocks;
    expect(blocks.purpose.body).toBe("Low value purpose text.");
    expect(blocks.purpose.rendered).toBe(false);
    expect(blocks.responsibility.rendered).toBe(true);
    const markdown = await readFile(join(rootDir, "src/pricing.codelore.md"), "utf8");
    expect(markdown).not.toContain("Low value purpose text.");
    expect(markdown).toContain("Owns only the rounding step.");
  });
});

function buffer(): { readonly text: string; write: (chunk: string) => boolean } {
  let text = "";
  return {
    get text(): string {
      return text;
    },
    write(chunk: string): boolean {
      text += chunk;
      return true;
    },
  };
}

function block(
  text: string,
  scores: { informativeness?: number; novelty?: number; specificity?: number } = {}
): Record<string, unknown> {
  return {
    text,
    refs: [],
    novelFact: text,
    informativeness: scores.informativeness ?? 0.75,
    novelty: scores.novelty ?? 0.75,
    specificity: scores.specificity ?? 0.75,
  };
}

function writerContent(sectionId: string, blocks: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({ sections: { [sectionId]: { blocks } } });
}

function userPrompt(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
  return body.messages.find((message) => message.role === "user")?.content ?? "";
}

function targetBlocksFromPrompt(prompt: string): string[] {
  const ids = new Set<string>();
  for (const match of prompt.matchAll(/"targetBlocks":\s*\[([^\]]*)\]/g)) {
    for (const id of match[1].matchAll(/"([a-zA-Z]+)"/g)) {
      ids.add(id[1]);
    }
  }
  return [...ids];
}

/**
 * Generation runs in two phases (propagating P/R/I, then terminal blocks). The writer
 * parser rejects blocks outside the request's targetBlocks, so the mock echoes exactly
 * the blocks the request asked for. `overrides` set specific bodies/scores. Verify
 * requests carry no targetBlocks → an empty (no-contradiction) reply.
 */
function writerReply(
  sectionId: string,
  init: RequestInit | undefined,
  overrides: Record<string, Record<string, unknown>> = {}
): string {
  const blocks: Record<string, Record<string, unknown>> = {};
  for (const target of targetBlocksFromPrompt(userPrompt(init))) {
    blocks[target] = overrides[target] ?? block(`Generated ${target}.`);
  }
  return writerContent(sectionId, blocks);
}

function llmResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-cli-"));
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
