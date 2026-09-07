import type { CodeEntity, CodeIndex, WriterBudget } from "../types.js";
import type { FileWriteSection } from "./file-writer.js";
import { stripComments } from "./strip-comments.js";

export interface WriterChunk {
  part: number;
  parts: number;
  files: Array<{ path: string; source: string }>;
  sections: FileWriteSection[];
}

interface SourceFileInput {
  path: string;
  source: string;
}

interface ChunkDraft {
  files: SourceFileInput[];
  /** Exact source segments the draft covers, for section assignment. */
  coverage: Array<{ path: string; startOffset: number; endOffset: number }>;
}

/** The comment-stripped length is what actually reaches the model, so the budget is measured against it. */
function sentLength(source: string): number {
  return stripComments(source).length;
}

/**
 * Splits a generation group into writer-sized chunks. The per-chunk source budget
 * is the model's prompt budget (from provider config) minus the shared prefix
 * overhead, converted to chars via the model's chars-per-token ratio. Files are
 * partitioned at top-level entity boundaries (a class with its methods stays in
 * one segment), every chunk repeats the file header (imports/module consts), and
 * chunks that contain no target sections are dropped — their code is not sent.
 */
export function planWriterChunks(input: {
  sources: SourceFileInput[];
  sections: FileWriteSection[];
  code: CodeIndex;
  budget: WriterBudget;
  /** Chars of the per-chunk shared prefix (rules + project context + dependency docs), measured once. */
  overheadChars: number;
}): WriterChunk[] {
  const maxSourceChars = Math.max(0, input.budget.maxPromptTokens * input.budget.charsPerToken - input.overheadChars);
  const maxSections = input.budget.maxSectionsPerChunk;
  const total = input.sources.reduce((sum, file) => sum + sentLength(file.source), 0);
  if (total <= maxSourceChars && input.sections.length <= maxSections) {
    return [
      {
        part: 1,
        parts: 1,
        files: input.sources.map((file) => ({ path: file.path, source: stripComments(file.source) })),
        sections: input.sections,
      },
    ];
  }

  const drafts =
    total <= maxSourceChars
      ? input.sources.map(wholeFileDraft)
      : input.sources.flatMap((file) => splitFile(file, input.code, maxSourceChars));
  const sectionsByDraft = assignSections(drafts, input.sections, input.code);

  const pieces: Array<{ draft: ChunkDraft; sections: FileWriteSection[] }> = [];
  for (const draft of drafts) {
    const draftSections = sectionsByDraft.get(draft) ?? [];
    for (let start = 0; start < draftSections.length; start += maxSections) {
      pieces.push({ draft, sections: draftSections.slice(start, start + maxSections) });
    }
  }
  return pieces.map((piece, index) => ({
    part: index + 1,
    parts: pieces.length,
    files: piece.draft.files,
    sections: piece.sections,
  }));
}

function assignSections(
  drafts: ChunkDraft[],
  sections: FileWriteSection[],
  code: CodeIndex
): Map<ChunkDraft, FileWriteSection[]> {
  const sectionsByDraft = new Map<ChunkDraft, FileWriteSection[]>(drafts.map((draft) => [draft, []]));
  for (const section of sections) {
    const entity = code.entities[section.entity.id];
    const draft = draftForSection(drafts, entity) ?? drafts[0];
    if (draft) {
      sectionsByDraft.get(draft)?.push(section);
    }
  }
  return sectionsByDraft;
}

function draftForSection(drafts: ChunkDraft[], entity: CodeEntity | undefined): ChunkDraft | undefined {
  if (!entity) {
    return undefined;
  }
  const byRange = drafts.find((draft) =>
    draft.coverage.some(
      (segment) =>
        segment.path === entity.path &&
        entity.range.startOffset >= segment.startOffset &&
        entity.range.startOffset < segment.endOffset
    )
  );
  return byRange ?? drafts.find((draft) => draft.files.some((file) => file.path === entity.path));
}

function splitFile(file: SourceFileInput, code: CodeIndex, maxSourceChars: number): ChunkDraft[] {
  if (sentLength(file.source) <= maxSourceChars) {
    return [wholeFileDraft(file)];
  }
  const cutPoints = topLevelStarts(file.path, code);
  if (cutPoints.length === 0) {
    return [wholeFileDraft(file)];
  }

  const header = file.source.slice(0, cutPoints[0]);
  const headerSize = sentLength(header);
  const segments = cutPoints.map((start, index) => ({
    startOffset: start,
    endOffset: cutPoints[index + 1] ?? file.source.length,
  }));

  const drafts: ChunkDraft[] = [];
  let current: typeof segments = [];
  let currentSize = headerSize;
  const flush = () => {
    if (current.length > 0) {
      drafts.push(draftFromSegments(file, header, current));
      current = [];
      currentSize = headerSize;
    }
  };
  for (const segment of segments) {
    const size = sentLength(file.source.slice(segment.startOffset, segment.endOffset));
    if (current.length > 0 && currentSize + size > maxSourceChars) {
      flush();
    }
    current.push(segment);
    currentSize += size;
  }
  flush();
  return drafts;
}

function wholeFileDraft(file: SourceFileInput): ChunkDraft {
  return {
    files: [{ path: file.path, source: stripComments(file.source) }],
    // Coverage offsets refer to the original source: section assignment uses
    // entity ranges from the code index, which include comments.
    coverage: [{ path: file.path, startOffset: 0, endOffset: file.source.length }],
  };
}

function draftFromSegments(
  file: SourceFileInput,
  header: string,
  segments: Array<{ startOffset: number; endOffset: number }>
): ChunkDraft {
  // Pieces are comment-stripped BEFORE joining so the omission markers survive.
  const omitted = `\n// … (unrelated parts of ${file.path} omitted)\n`;
  const pieces = [
    stripComments(header).trimEnd(),
    ...segments.map((segment) => stripComments(file.source.slice(segment.startOffset, segment.endOffset))),
  ];
  return {
    files: [{ path: file.path, source: pieces.join(omitted) }],
    coverage: segments.map((segment) => ({ path: file.path, ...segment })),
  };
}

/** Offsets of top-level entity starts: cut points that keep a class with its methods together. */
function topLevelStarts(path: string, code: CodeIndex): number[] {
  const entities = (code.fileToEntities[path] ?? [])
    .map((id) => code.entities[id])
    .filter((entity): entity is CodeEntity => Boolean(entity) && entity.type !== "file");
  const topLevel = entities.filter(
    (entity) =>
      !entities.some(
        (other) =>
          other.id !== entity.id &&
          other.range.startOffset <= entity.range.startOffset &&
          other.range.endOffset >= entity.range.endOffset &&
          other.range.endOffset - other.range.startOffset > entity.range.endOffset - entity.range.startOffset
      )
  );
  return [...new Set(topLevel.map((entity) => entity.range.startOffset))].sort((left, right) => left - right);
}
