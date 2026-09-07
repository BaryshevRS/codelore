import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { transformDocument } from "./markdown.js";

const MANIFEST_VERSION = 1;

export interface SyncSiteInput {
  rootDir: string;
  outputDir: string;
}

export interface SyncSiteResult {
  written: string[];
  removed: string[];
}

interface DocStateReference {
  version: number;
  docPath: string;
}

interface ContentManifest {
  version: number;
  files: string[];
}

export async function syncSite(input: SyncSiteInput): Promise<SyncSiteResult> {
  const indexDir = await readIndexDir(input.rootDir);
  const docPaths = await listCanonicalDocPaths(join(input.rootDir, indexDir, "state"));
  const destinationByDocPath = new Map(docPaths.map((docPath) => [docPath, destinationFor(docPath)]));
  const routeByDocPath = new Map(
    docPaths.map((docPath) => [docPath, routeFor(docPath)]),
  );
  const manifestPath = join(input.outputDir, ".codelore-site", "content-manifest.json");
  const previousManifest = await readManifest(manifestPath);
  const nextFiles = [...destinationByDocPath.values()].sort();

  for (const docPath of docPaths) {
    assertRelativeDocPath(docPath);
    const markdown = await readFile(join(input.rootDir, docPath), "utf8");
    const transformed = transformDocument({ docPath, markdown, routeByDocPath });
    const destination = destinationByDocPath.get(docPath);
    if (!destination) {
      throw new Error(`Missing destination for Codelore document "${docPath}"`);
    }

    const outputPath = pathWithin(input.outputDir, destination);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, transformed, "utf8");
  }

  const removed = previousManifest.files.filter((file) => !nextFiles.includes(file)).sort();
  for (const file of removed) {
    await rm(pathWithin(input.outputDir, file), { force: true });
  }

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: MANIFEST_VERSION, files: nextFiles }, null, 2)}\n`,
    "utf8",
  );

  return { written: nextFiles, removed };
}

async function readIndexDir(rootDir: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(rootDir, "codelore.config.json"), "utf8")) as {
      indexDir?: unknown;
    };
    return typeof raw.indexDir === "string" ? raw.indexDir : ".codelore";
  } catch (error) {
    if (isMissingFile(error)) {
      return ".codelore";
    }
    throw error;
  }
}

async function listCanonicalDocPaths(stateRoot: string): Promise<string[]> {
  const stateFiles = await listFiles(stateRoot);
  const docPaths = new Set<string>();

  for (const statePath of stateFiles) {
    if (!statePath.endsWith(".json") || statePath.includes(".generation-debug.")) {
      continue;
    }

    const state = JSON.parse(await readFile(statePath, "utf8")) as Partial<DocStateReference>;
    if (typeof state.version === "number" && typeof state.docPath === "string") {
      docPaths.add(state.docPath);
    }
  }

  return [...docPaths].sort();
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(directory, entry.name);
        return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
      }),
    );
    return files.flat();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function destinationFor(docPath: string): string {
  if (!docPath.endsWith(".codelore.md")) {
    throw new Error(`Unsupported Codelore document path "${docPath}"`);
  }

  const sourcePath = docPath.slice(0, -".codelore.md".length);
  return sourcePath === "overview" ? "content/docs/index.md" : `content/docs/${sourcePath}.md`;
}

function routeFor(docPath: string): string {
  const destination = destinationFor(docPath).slice("content/docs/".length, -".md".length);
  return destination === "index" ? "/docs" : `/docs/${destination}`;
}

async function readManifest(manifestPath: string): Promise<ContentManifest> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<ContentManifest>;
    if (manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.files)) {
      throw new Error(`Unsupported Codelore site manifest at "${manifestPath}"`);
    }
    return { version: MANIFEST_VERSION, files: manifest.files.filter((file): file is string => typeof file === "string") };
  } catch (error) {
    if (isMissingFile(error)) {
      return { version: MANIFEST_VERSION, files: [] };
    }
    throw error;
  }
}

function assertRelativeDocPath(docPath: string): void {
  if (isAbsolute(docPath) || docPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Codelore document path must be relative: "${docPath}"`);
  }
}

function pathWithin(rootDir: string, childPath: string): string {
  const absoluteRoot = resolve(rootDir);
  const absoluteChild = resolve(absoluteRoot, childPath);
  if (relative(absoluteRoot, absoluteChild).startsWith("..")) {
    throw new Error(`Generated site path escapes output directory: "${childPath}"`);
  }
  return absoluteChild;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
