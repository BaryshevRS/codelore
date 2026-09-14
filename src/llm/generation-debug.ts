import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlockId } from "../markdown/block-ids.js";
import type { DocViolation } from "./doc-validator.js";
import type { DependencyDoc, FileWriteSection } from "./file-writer.js";
import type { ChatCompletionInput, ChatMessage, ChatUsage } from "./provider.js";

/** "fileGeneration" / "repair", suffixed with " <part>/<parts>" for chunked files. */
export type GenerationDebugLlmStageName = string;

export type GenerationDebugLlmPipeline = Record<string, GenerationDebugLlmStage>;

export type GenerationDebugLlmPipelineInput = Record<string, GenerationDebugLlmStageInput>;

export interface GenerationDebugLlmStageInput {
  request: ChatCompletionInput;
  response: {
    content: string;
    usage?: ChatUsage;
  };
}

export interface GenerationDebugLlmStage {
  request: {
    messages: GenerationDebugMessage[];
    stats: TextStats;
  };
  response: {
    content: string;
    stats: TextStats;
    usage?: ChatUsage;
  };
}

export type GenerationDebugMessage = ChatMessage & {
  stats: TextStats;
};

export interface TextStats {
  chars: number;
  approxTokens: number;
}

export interface GenerationDebugError {
  stage:
    | "file_generation_request"
    | "file_generation_parse"
    | "repair_request"
    | "repair_parse"
    | "verification_request"
    | "verification_parse"
    | "rewrite";
  message: string;
  code?: string;
}

export interface GenerationDebugEntry {
  version: 4;
  runId: string;
  timestamp: string;
  command: string;
  provider: string;
  model: string;
  docPath: string;
  files: string[];
  sections: Array<Pick<FileWriteSection, "sectionId" | "targetBlocks" | "allowedBlocks">>;
  dependencyDocs: Array<{ sourcePath: string; sections: number; chars: number }>;
  llm: GenerationDebugLlmPipeline;
  violations?: DocViolation[];
  violationsAfterRepair?: DocViolation[];
  writtenBlocks: Record<string, BlockId[]>;
  keptBlocks: Array<{ sectionId: string; blockId: BlockId; reason: string }>;
  error?: GenerationDebugError;
}

export interface BuildGenerationDebugEntryInput {
  runId: string;
  timestamp: string;
  command: string;
  provider: string;
  model: string;
  docPath: string;
  files: string[];
  sections: FileWriteSection[];
  dependencyDocs: DependencyDoc[];
  llmStages: GenerationDebugLlmPipelineInput;
  violations?: DocViolation[];
  violationsAfterRepair?: DocViolation[];
  writtenBlocks?: Record<string, BlockId[]>;
  keptBlocks?: Array<{ sectionId: string; blockId: BlockId; reason: string }>;
  error?: GenerationDebugError;
}

export function buildGenerationDebugEntry(input: BuildGenerationDebugEntryInput): GenerationDebugEntry {
  return {
    version: 4,
    runId: input.runId,
    timestamp: input.timestamp,
    command: input.command,
    provider: input.provider,
    model: input.model,
    docPath: input.docPath,
    files: input.files,
    sections: input.sections.map((section) => ({
      sectionId: section.sectionId,
      targetBlocks: section.targetBlocks,
      allowedBlocks: section.allowedBlocks,
    })),
    dependencyDocs: input.dependencyDocs.map((doc) => ({
      sourcePath: doc.sourcePath,
      sections: doc.sections.length,
      chars: JSON.stringify(doc.sections).length,
    })),
    llm: mapLlmStages(input.llmStages),
    ...(input.violations && input.violations.length > 0 ? { violations: input.violations } : {}),
    ...(input.violationsAfterRepair && input.violationsAfterRepair.length > 0
      ? { violationsAfterRepair: input.violationsAfterRepair }
      : {}),
    writtenBlocks: input.writtenBlocks ?? {},
    keptBlocks: input.keptBlocks ?? [],
    ...(input.error ? { error: input.error } : {}),
  };
}

/**
 * A debug entry carries the whole prompt and the model's reply, so the dumps are
 * opt-in: without `CODELORE_DEBUG` a run leaves nothing behind in the user's
 * repository. Any non-empty value enables them.
 */
export function generationDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CODELORE_DEBUG ?? "") !== "";
}

export async function writeGenerationDebug(input: {
  statePath: string;
  entry: GenerationDebugEntry;
  phase?: string;
}): Promise<{ debugPath: string }> {
  const debugPath = generationDebugPathForStatePath(input.statePath, input.phase);
  if (!generationDebugEnabled()) {
    return { debugPath };
  }
  await mkdir(dirname(debugPath), { recursive: true });
  // Concurrent chunks may write debug for the same doc; a shared tmp name would race.
  const tmpPath = `${debugPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(input.entry, null, 2)}\n`, "utf8");
  await rename(tmpPath, debugPath);
  return { debugPath };
}

/**
 * What one run decided before it ever spoke to the model: what the stale scan
 * found, what reached the work queue, and what the pipeline reported back. The
 * per-doc debug files only exist for docs that made it into the pipeline, so a
 * block that was silently never queued leaves no trace at all there — its absence
 * is indistinguishable from debugging being off. This record closes that gap.
 */
export interface RunDecisionsEntry {
  version: 1;
  runId: string;
  timestamp: string;
  command: string;
  found: {
    stale: Array<{ sectionId: string; blockId: string; drift: string; changedFacets: string[] }>;
    tombstoned: Array<{ sectionId: string; blockId: string }>;
  };
  queued: Array<{ sectionId: string; blocks: string[] }>;
  outcome: {
    updated: Array<{ sectionId: string; blocks: string[] }>;
    skipped: Array<{ sectionId: string; reason: string }>;
    failed: Array<{ sectionId: string; reason: string }>;
  };
  /** Domain/overview docs, which the file pipeline's result never covers. */
  tier?: { generated: string[]; droppedBlocks: number };
}

/** `<indexDir>/runs/<timestamp>-<runId>.json` — one file per run, newest last by name. */
export function runDecisionsPath(rootDir: string, indexDir: string, entry: RunDecisionsEntry): string {
  const stamp = entry.timestamp.replace(/[:.]/g, "-");
  return join(rootDir, indexDir, "runs", `${stamp}-${entry.runId}.json`);
}

export async function writeRunDecisions(input: {
  rootDir: string;
  indexDir: string;
  entry: RunDecisionsEntry;
}): Promise<{ decisionsPath: string }> {
  const decisionsPath = runDecisionsPath(input.rootDir, input.indexDir, input.entry);
  if (!generationDebugEnabled()) {
    return { decisionsPath };
  }
  await mkdir(dirname(decisionsPath), { recursive: true });
  const tmpPath = `${decisionsPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(input.entry, null, 2)}\n`, "utf8");
  await rename(tmpPath, decisionsPath);
  return { decisionsPath };
}

/** Per-phase debug files so a two-phase run keeps both traces instead of overwriting. */
export function generationDebugPathForStatePath(statePath: string, phase?: string): string {
  const suffix = phase ? `.generation-debug.${phase}.json` : ".generation-debug.json";
  return statePath.replace(/\.json$/, suffix);
}

function mapLlmStages(stages: GenerationDebugLlmPipelineInput): GenerationDebugLlmPipeline {
  return Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [
      name,
      {
        request: {
          messages: stage.request.messages.map((message) => ({
            ...message,
            stats: textStats(message.content),
          })),
          stats: textStats(stage.request.messages.map((message) => message.content).join("\n")),
        },
        response: {
          content: stage.response.content,
          stats: textStats(stage.response.content),
          ...(stage.response.usage ? { usage: stage.response.usage } : {}),
        },
      },
    ])
  ) as GenerationDebugLlmPipeline;
}

function textStats(text: string): TextStats {
  return {
    chars: text.length,
    approxTokens: Math.ceil(text.length / 4),
  };
}
