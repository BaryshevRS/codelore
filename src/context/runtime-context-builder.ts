import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ModuleResolutionKind, Project, ScriptTarget, type SourceFile } from "ts-morph";
import type { CodeIndex, RuntimeHit } from "../types.js";
import { AstHitFilter } from "./ast-hit-filter.js";
import { resolveEnclosing } from "./enclosing-resolver.js";
import { extractLiterals } from "./literal-extractor.js";
import { type RipgrepHit, searchLiteral } from "./ripgrep-runner.js";

export interface BuildRuntimeContextInput {
  targetEntityId: string;
  codeIndex: CodeIndex;
  rootDir: string;
}

export interface RuntimeContextResult {
  hits: RuntimeHit[];
  unresolvedLiterals: string[];
}

interface BuildContext {
  targetEntityId: string;
  codeIndex: CodeIndex;
  rootDir: string;
  filter: AstHitFilter;
}

export async function buildRuntimeContext(input: BuildRuntimeContextInput): Promise<RuntimeContextResult> {
  const { targetEntityId, codeIndex, rootDir } = input;
  const target = codeIndex.entities[targetEntityId];
  if (!target) {
    return { hits: [], unresolvedLiterals: [] };
  }

  const project = createProject(rootDir);
  const targetAbsolutePath = absolutePath(rootDir, target.path);
  const targetSource = loadSource(project, targetAbsolutePath);
  if (!targetSource) {
    return { hits: [], unresolvedLiterals: [] };
  }

  const literals = extractLiterals(targetSource, target.range);
  if (literals.length === 0) {
    return { hits: [], unresolvedLiterals: [] };
  }

  const context: BuildContext = {
    targetEntityId,
    codeIndex,
    rootDir,
    filter: new AstHitFilter(project),
  };
  const unresolvedLiterals: string[] = [];
  const allHits: RuntimeHit[] = [];

  for (const literalValue of uniqueValues(literals)) {
    const rgHits = await searchLiteral(literalValue, { rootDir, excludeFiles: [targetAbsolutePath] });
    const hits = resolveHitsForLiteral(rgHits, literalValue, context);
    if (hits.length === 0) {
      unresolvedLiterals.push(literalValue);
      continue;
    }
    allHits.push(...hits);
  }

  return { hits: allHits, unresolvedLiterals };
}

function resolveHitsForLiteral(rgHits: RipgrepHit[], literalValue: string, context: BuildContext): RuntimeHit[] {
  const result: RuntimeHit[] = [];
  for (const rgHit of rgHits) {
    const resolved = resolveSingleHit(rgHit, literalValue, context);
    if (resolved) {
      result.push(resolved);
    }
  }
  return result;
}

function resolveSingleHit(rgHit: RipgrepHit, literalValue: string, context: BuildContext): RuntimeHit | null {
  const filtered = context.filter.filter(rgHit, literalValue);
  if (!filtered) {
    return null;
  }
  const sourceFile = context.filter.getSourceFile(filtered.file);
  if (!sourceFile) {
    return null;
  }
  const indexFileKey = relative(context.rootDir, filtered.file);
  const resolved = resolveEnclosing({
    hit: filtered,
    sourceFile,
    codeIndex: context.codeIndex,
    indexFileKey,
  });
  if (!resolved || resolved.entityId === context.targetEntityId) {
    return null;
  }
  return resolved;
}

function createProject(rootDir: string): Project {
  const tsConfigFilePath = join(rootDir, "tsconfig.json");
  if (existsSync(tsConfigFilePath)) {
    return new Project({
      tsConfigFilePath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, checkJs: false },
    });
  }
  return new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      moduleResolution: ModuleResolutionKind.NodeNext,
      target: ScriptTarget.ES2022,
    },
  });
}

function loadSource(project: Project, filePath: string): SourceFile | null {
  try {
    return project.addSourceFileAtPath(filePath);
  } catch {
    return null;
  }
}

function uniqueValues(literals: Array<{ value: string }>): string[] {
  return Array.from(new Set(literals.map((entry) => entry.value)));
}

function absolutePath(rootDir: string, relativeOrAbsolute: string): string {
  if (relativeOrAbsolute.startsWith("/")) {
    return relativeOrAbsolute;
  }
  const normalized = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;
  return `${normalized}${relativeOrAbsolute}`;
}
