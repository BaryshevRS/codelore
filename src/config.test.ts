import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadDotEnv, resolveTerms } from "./config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("ships no LLM endpoint by default, so nothing is sent to an unchosen service", async () => {
    const rootDir = await makeTempProject({});

    const config = loadConfig(rootDir);

    expect(config.llm.provider).toBe("");
    expect(config.llm.providers).toEqual({});
  });

  it("deep-merges the gitignored <indexDir>/config.json overlay over the committed base, overlay wins", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        sourceGlobs: ["app/**/*.ts"],
        thresholds: { minScore: 0.9 },
      }),
      ".codelore/config.json": JSON.stringify({
        sourceGlobs: ["lib/**/*.ts"],
        llm: {
          provider: "local",
          providers: { local: { type: "openai-compatible", baseUrl: "http://x/v1/", model: "m" } },
        },
      }),
    });

    const config = loadConfig(rootDir);

    expect(config.sourceGlobs).toEqual(["lib/**/*.ts"]); // overlay wins on conflict
    expect(config.thresholds.minScore).toBe(0.9); // base-only key survives the merge
    expect(config.llm.provider).toBe("local"); // llm comes entirely from the overlay
  });

  it("resolves the overlay path from the base config's own indexDir, not the default", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({ indexDir: "custom-dir" }),
      "custom-dir/config.json": JSON.stringify({
        llm: {
          provider: "local",
          providers: { local: { type: "openai-compatible", baseUrl: "http://x/v1/", model: "m" } },
        },
      }),
    });

    const config = loadConfig(rootDir);

    expect(config.llm.provider).toBe("local");
  });

  it("keeps base providers the overlay does not mention", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        llm: {
          provider: "base",
          providers: {
            base: {
              type: "openai-compatible",
              baseUrl: "https://example.test/v1/",
              model: "base-model",
              apiKey: "test-key",
            },
          },
        },
      }),
      ".codelore/config.json": JSON.stringify({
        llm: {
          provider: "local",
          providers: {
            local: {
              type: "openai-compatible",
              baseUrl: "http://127.0.0.1:11434/v1/",
              model: "custom",
              apiKey: "test-key",
            },
          },
        },
      }),
    });

    const config = loadConfig(rootDir);

    expect(config.llm.provider).toBe("local");
    expect(config.llm.providers.local).toMatchObject({ model: "custom" });
    expect(config.llm.providers.base).toMatchObject({ model: "base-model" });
  });

  it("carries verifyProvider through the merge and omits it when unset", async () => {
    const withVerify = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        llm: {
          provider: "main",
          verifyProvider: "cheap",
          providers: {
            main: { type: "openai-compatible", baseUrl: "http://x/v1/", model: "big" },
            cheap: { type: "openai-compatible", baseUrl: "http://x/v1/", model: "small" },
          },
        },
      }),
    });
    expect(loadConfig(withVerify).llm.verifyProvider).toBe("cheap");

    const withoutVerify = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        llm: {
          provider: "main",
          providers: { main: { type: "openai-compatible", baseUrl: "http://x/v1/", model: "big" } },
        },
      }),
    });
    expect(loadConfig(withoutVerify).llm.verifyProvider).toBeUndefined();
  });

  it("throws on an unknown config key instead of silently ignoring the typo", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({ sourceGlob: ["src/**/*.ts"] }),
    });

    expect(() => loadConfig(rootDir)).toThrow(/sourceGlob/);
  });

  it("throws on a wrong-typed value instead of letting it fail later", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({ thresholds: { weightFull: "3" } }),
    });

    expect(() => loadConfig(rootDir)).toThrow(/weightFull/);
  });

  it("resolves canonical language plus translation languages, excluding the canonical from translations", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({ docs: { language: "ru", translations: ["en", "ru", "de"] } }),
    });

    const { docs } = loadConfig(rootDir);

    expect(docs.language).toBe("ru");
    expect(docs.translations).toEqual(["en", "de"]); // canonical "ru" dropped, order preserved
    expect(docs.blockHeadings.purpose).toBe("Зачем это нужно"); // canonical headings
    expect(docs.blockHeadingsByLanguage.en.purpose).toBe("Purpose");
    expect(docs.blockHeadingsByLanguage.de.purpose).toBe("Purpose"); // no "de" bundle → English heading fallback
  });

  it("defaults to no translations", async () => {
    const config = loadConfig(await makeTempProject({}));
    expect(config.docs.translations).toEqual([]);
    expect(config.docs.blockHeadingsByLanguage).toEqual({});
  });

  it("loads flat writing rules and normalizes glob-scoped term groups", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        docs: {
          writingRules: ["Use dry prose."],
          terms: [
            { ru: ["блок", "секция"], en: ["block", "section"] },
            { match: "src/graph/**", ru: ["волна"], en: ["wave"] },
          ],
        },
      }),
    });

    const config = loadConfig(rootDir);

    expect(config.docs.writingRules).toEqual(["Use dry prose."]);
    expect(config.docs.terms).toEqual([
      { byLanguage: { ru: ["блок", "секция"], en: ["block", "section"] } },
      { match: "src/graph/**", byLanguage: { ru: ["волна"], en: ["wave"] } },
    ]);
  });

  it("resolves terms by glob scope and language: global first, module overlay merged, deduped", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        docs: {
          language: "ru",
          terms: [
            { ru: ["блок", "секция"], en: ["block", "section"] },
            { match: "src/graph/**", ru: ["волна", "блок"] },
            { match: "src/llm/**", ru: ["чанк"] },
          ],
        },
      }),
    });
    const { docs } = loadConfig(rootDir);

    // graph file: global ∪ graph group, "блок" not duplicated
    expect(resolveTerms(docs, ["src/graph/file-dag.ts"], "ru")).toEqual(["блок", "секция", "волна"]);
    // unmatched file: only the global group
    expect(resolveTerms(docs, ["src/service/x.ts"], "ru")).toEqual(["блок", "секция"]);
    // language without terms in the matched groups → empty
    expect(resolveTerms(docs, ["src/graph/file-dag.ts"], "en")).toEqual(["block", "section"]);
  });

  it("normalizes a flat terms string[] into one global group scoped to the canonical language", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        docs: { language: "ru", terms: ["блок", "секция"] },
      }),
    });

    const { docs } = loadConfig(rootDir);

    expect(docs.terms).toEqual([{ byLanguage: { ru: ["блок", "секция"] } }]);
    expect(resolveTerms(docs, ["src/anything.ts"], "ru")).toEqual(["блок", "секция"]);
  });

  it("throws when a flat terms string[] is used without a canonical docs.language", async () => {
    const rootDir = await makeTempProject({
      "codelore.config.json": JSON.stringify({
        docs: { terms: ["блок", "секция"] },
      }),
    });

    expect(() => loadConfig(rootDir)).toThrow(/docs\.language is not set/);
  });
});

describe("loadDotEnv", () => {
  const key = "CODELORE_TEST_DOTENV_KEY";

  afterEach(() => {
    delete process.env[key];
  });

  it("loads variables from .env in rootDir into process.env", async () => {
    const rootDir = await makeTempProject({ ".env": `${key}=from-dotenv\n` });

    loadDotEnv(rootDir);

    expect(process.env[key]).toBe("from-dotenv");
  });

  it("is a no-op when .env is absent", async () => {
    const rootDir = await makeTempProject({});

    expect(() => loadDotEnv(rootDir)).not.toThrow();
    expect(process.env[key]).toBeUndefined();
  });
});

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-config-"));
  tempDirs.push(rootDir);

  for (const [path, text] of Object.entries(files)) {
    const absolutePath = join(rootDir, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }

  return rootDir;
}
