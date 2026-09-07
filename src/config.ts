import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import { resolveBlockHeadings } from "./markdown/locales.js";
import type { BlockInclusionConfig, CodeloreConfig, DocsConfig, LlmConfig, TermGroup } from "./types.js";

/** Config-file shape of a term group: `match` plus one `string[]` per language code (flat, no `byLanguage` nesting). */
type TermGroupFile = { match?: string; [lang: string]: string | string[] | undefined };

type DocsConfigFile = {
  language?: string;
  translations?: string[];
  writingRules?: string[];
  // A flat string[] is shorthand for one global group scoped to the canonical
  // language — only meaningful when docs.language is set (see normalizeTermGroups).
  terms?: TermGroupFile[] | string[];
};

type CodeloreConfigFile = Partial<Omit<CodeloreConfig, "docs" | "rootDir" | "blockInclusion">> & {
  docs?: DocsConfigFile;
  blockInclusion?: Partial<BlockInclusionConfig>;
  llm?: Partial<LlmConfig>;
};

export const DEFAULT_STDLIB_PREFIXES = [
  "node:",
  "fs",
  "fs/promises",
  "path",
  "url",
  "crypto",
  "util",
  "os",
  "stream",
  "buffer",
  "events",
  "child_process",
  "http",
  "https",
  "net",
  "tls",
  "zlib",
  "querystring",
  "assert",
  "module",
  "worker_threads",
  "perf_hooks",
  "readline",
];

export const DEFAULT_SIGNIFICANT_GLOBALS = [
  "process",
  "window",
  "document",
  "globalThis",
  "self",
  "navigator",
  "localStorage",
  "sessionStorage",
];

const defaultConfig = {
  sourceGlobs: ["src/**/*.{ts,js}"],
  docGlobs: ["docs/**/*.md", "**/*.codelore.md"],
  excludeGlobs: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.codelore/**",
    "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
    "**/{__tests__,__specs__,test,tests,spec,specs}/**",
  ],
  indexDir: ".codelore",
  docs: {
    translations: [],
    writingRules: [],
    terms: [],
    blockHeadings: resolveBlockHeadings(undefined),
    blockHeadingsByLanguage: {},
  },
  thresholds: {
    weightMinimal: 1.0,
    weightFull: 3.0,
    minScore: 0.5,
    classFieldOverlap: 0.5,
  },
  blockInclusion: {
    enabled: true,
    stdlibPrefixes: DEFAULT_STDLIB_PREFIXES,
    significantGlobals: DEFAULT_SIGNIFICANT_GLOBALS,
  },
  llm: {
    provider: "aitunnel",
    providers: {
      aitunnel: {
        type: "openai-compatible",
        baseUrl: "https://api.aitunnel.ru/v1/",
        model: "deepseek-v4-flash",
        apiKeyEnv: "AI_API_KEY",
        temperature: 0.2,
        timeoutMs: 300000,
        contextWindow: 65536,
        reservedOutputTokens: 8192,
        charsPerToken: 4,
        maxSectionsPerChunk: 6,
      },
    },
    concurrency: 50,
    verifyTypeContext: true,
  },
} satisfies Omit<CodeloreConfig, "rootDir">;

/**
 * Loads `<rootDir>/.env` into `process.env` so `apiKeyEnv` resolves locally
 * without exporting shell variables. No-op when the file is absent (the CI/MCP
 * case, where the secret is injected by the runner/host env instead). A malformed
 * `.env` is surfaced, not swallowed.
 */
export function loadDotEnv(rootDir: string): void {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  process.loadEnvFile(envPath);
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge for the committed base + gitignored `.local` overlay: local wins, objects merge, arrays/scalars replace. */
function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

const stringArray = z.array(z.string());
// A term group: `match` (a path glob) plus one string[] per language code. `catchall`
// admits arbitrary language keys; `match` stays a string. Flat here, nested into
// `byLanguage` at normalization.
const termGroupSchema = z.object({ match: z.string().optional() }).catchall(stringArray);

const positiveInt = z.number().int().positive();

const providerSchema = z
  .object({
    type: z.literal("openai-compatible"),
    baseUrl: z.string(),
    model: z.string(),
    apiKeyEnv: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    temperature: z.number().optional(),
    timeoutMs: z.number().optional(),
    contextWindow: positiveInt.optional(),
    reservedOutputTokens: positiveInt.optional(),
    charsPerToken: z.number().positive().optional(),
    maxSectionsPerChunk: positiveInt.optional(),
    responseFormat: z.enum(["json_object", "json_schema"]).optional(),
  })
  .strict()
  .refine((config) => (config.contextWindow ?? Infinity) > (config.reservedOutputTokens ?? 0), {
    message: "contextWindow must exceed reservedOutputTokens",
    path: ["contextWindow"],
  });

/** Strict schema for the merged config file: unknown keys (typos) and wrong types fail loudly at load instead of silently falling back to defaults. */
const configFileSchema = z
  .object({
    sourceGlobs: stringArray.optional(),
    docGlobs: stringArray.optional(),
    excludeGlobs: stringArray.optional(),
    indexDir: z.string().optional(),
    docs: z
      .object({
        language: z.string().optional(),
        translations: stringArray.optional(),
        writingRules: stringArray.optional(),
        // Flat string[] shorthand for a single global group scoped to docs.language,
        // or the full grouped form (`match` + one string[] per language).
        terms: z.union([stringArray, z.array(termGroupSchema)]).optional(),
      })
      .strict()
      .optional(),
    thresholds: z
      .object({
        weightMinimal: z.number().optional(),
        weightFull: z.number().optional(),
        minScore: z.number().optional(),
        classFieldOverlap: z.number().optional(),
        perBlockScore: z.record(z.string(), z.number()).optional(),
      })
      .strict()
      .optional(),
    blockInclusion: z
      .object({
        enabled: z.boolean().optional(),
        stdlibPrefixes: stringArray.optional(),
        significantGlobals: stringArray.optional(),
      })
      .strict()
      .optional(),
    llm: z
      .object({
        provider: z.string().optional(),
        providers: z.record(z.string(), providerSchema).optional(),
        verifyProvider: z.string().optional(),
        partitionProvider: z.string().optional(),
        concurrency: z.number().optional(),
        verifyTypeContext: z.boolean().optional(),
      })
      .strict()
      .optional(),
    sideEffectPatterns: stringArray.optional(),
    entryPoints: z
      .object({
        barrelFiles: stringArray.optional(),
        decorators: stringArray.optional(),
        pathPatterns: stringArray.optional(),
        explicit: stringArray.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function validateConfigFile(merged: Record<string, unknown>): CodeloreConfigFile {
  const result = configFileSchema.safeParse(merged);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid codelore config (codelore.config.json / <indexDir>/config.json):\n${details}`);
  }
  return result.data as CodeloreConfigFile;
}

/**
 * Loads the committed `codelore.config.json` first to learn `indexDir` (default
 * `.codelore`), then merges the gitignored `<indexDir>/config.json` private overlay on
 * top — the escape hatch for settings a project doesn't want committed (e.g. an
 * internal `llm.providers` baseUrl). The overlay lives inside indexDir alongside
 * `state/`, not in the repo root, so root stays a single committed config file.
 */
export function loadConfig(rootDir: string): CodeloreConfig {
  const base = readJsonIfExists(join(rootDir, "codelore.config.json"));
  const indexDir = typeof base?.indexDir === "string" ? base.indexDir : defaultConfig.indexDir;
  const local = readJsonIfExists(join(rootDir, indexDir, "config.json"));
  if (base === undefined && local === undefined) {
    return { rootDir, ...defaultConfig };
  }

  return normalizeConfig(rootDir, validateConfigFile(deepMerge(base ?? {}, local ?? {})));
}

function normalizeConfig(rootDir: string, parsed: CodeloreConfigFile): CodeloreConfig {
  const parsedDocs = parsed.docs ?? {};
  return {
    rootDir,
    sourceGlobs: parsed.sourceGlobs ?? defaultConfig.sourceGlobs,
    docGlobs: parsed.docGlobs ?? defaultConfig.docGlobs,
    excludeGlobs: parsed.excludeGlobs ?? defaultConfig.excludeGlobs,
    indexDir: parsed.indexDir ?? defaultConfig.indexDir,
    docs: normalizeDocsConfig(parsedDocs),
    thresholds: {
      weightMinimal: parsed.thresholds?.weightMinimal ?? defaultConfig.thresholds.weightMinimal,
      weightFull: parsed.thresholds?.weightFull ?? defaultConfig.thresholds.weightFull,
      minScore: parsed.thresholds?.minScore ?? defaultConfig.thresholds.minScore,
      classFieldOverlap: parsed.thresholds?.classFieldOverlap ?? defaultConfig.thresholds.classFieldOverlap,
      perBlockScore: parsed.thresholds?.perBlockScore,
    },
    blockInclusion: {
      enabled: parsed.blockInclusion?.enabled ?? defaultConfig.blockInclusion.enabled,
      stdlibPrefixes: parsed.blockInclusion?.stdlibPrefixes ?? defaultConfig.blockInclusion.stdlibPrefixes,
      significantGlobals: parsed.blockInclusion?.significantGlobals ?? defaultConfig.blockInclusion.significantGlobals,
    },
    llm: mergeLlmConfig(parsed.llm),
    sideEffectPatterns: parsed.sideEffectPatterns,
    entryPoints: parsed.entryPoints,
  };
}

/**
 * Resolves the canonical language plus its derived translation languages. The
 * canonical language never appears in `translations` (translating into itself is
 * a no-op); each language's block headings come from its own locale bundle, never
 * a label in the wrong language.
 */
function normalizeDocsConfig(parsedDocs: DocsConfigFile): DocsConfig {
  const language = parsedDocs.language;
  const translations = [...new Set(parsedDocs.translations ?? [])].filter((lang) => lang !== language);
  return {
    language,
    translations,
    writingRules: parsedDocs.writingRules ?? defaultConfig.docs.writingRules,
    terms: normalizeTermGroups(parsedDocs.terms, language),
    blockHeadings: resolveBlockHeadings(language),
    blockHeadingsByLanguage: Object.fromEntries(translations.map((lang) => [lang, resolveBlockHeadings(lang)])),
  };
}

/**
 * Two file shapes: flat file groups (`{ match, ru: [...], en: [...] }`) → `{ match?,
 * byLanguage }`, with `match` separated from the language lists; or a flat `string[]`
 * shorthand for a single global group scoped to `language` (the canonical
 * `docs.language`) — only meaningful when a canonical language is configured, since
 * `resolveTerms` always looks terms up by language.
 */
function normalizeTermGroups(
  groups: TermGroupFile[] | string[] | undefined,
  language: string | undefined
): TermGroup[] {
  if (groups === undefined || groups.length === 0) {
    return [];
  }
  if (groups.every((group): group is string => typeof group === "string")) {
    if (language === undefined) {
      throw new Error(
        "docs.terms is a flat string[] (shorthand for canonical-language terms), but docs.language is not set. " +
          "Set docs.language, or use the grouped form [{ <lang>: [...] }] to name the language explicitly."
      );
    }
    return [{ byLanguage: { [language]: groups } }];
  }
  return (groups as TermGroupFile[]).map((group) => {
    const byLanguage: Record<string, string[]> = {};
    let match: string | undefined;
    for (const [key, value] of Object.entries(group)) {
      if (key === "match") {
        match = value as string;
      } else if (Array.isArray(value)) {
        byLanguage[key] = value;
      }
    }
    return match !== undefined ? { match, byLanguage } : { byLanguage };
  });
}

/**
 * Preferred terms for `language` that apply to `filePaths`: every group whose `match`
 * glob covers at least one of the files (a group without `match` is global), unioned
 * in config order (global groups first), deduped. The writer passes its group's source
 * files and the canonical language; the translator passes one doc's source file and the
 * target language.
 */
export function resolveTerms(docs: DocsConfig, filePaths: readonly string[], language: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of docs.terms) {
    if (group.match !== undefined && !filePaths.some((path) => picomatch.isMatch(path, group.match as string))) {
      continue;
    }
    for (const term of group.byLanguage[language] ?? []) {
      const trimmed = term.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

function mergeLlmConfig(parsed?: Partial<LlmConfig>): LlmConfig {
  const concurrency =
    typeof parsed?.concurrency === "number" && Number.isFinite(parsed.concurrency) && parsed.concurrency >= 1
      ? Math.floor(parsed.concurrency)
      : defaultConfig.llm.concurrency;
  return {
    provider: parsed?.provider ?? defaultConfig.llm.provider,
    providers: {
      ...defaultConfig.llm.providers,
      ...(parsed?.providers ?? {}),
    },
    ...(parsed?.verifyProvider ? { verifyProvider: parsed.verifyProvider } : {}),
    ...(parsed?.partitionProvider ? { partitionProvider: parsed.partitionProvider } : {}),
    concurrency,
    verifyTypeContext:
      typeof parsed?.verifyTypeContext === "boolean" ? parsed.verifyTypeContext : defaultConfig.llm.verifyTypeContext,
  };
}
