import { type MentionCandidate, mentionedDependencies } from "../analysis/block-mentions.js";
import { dependencyDocsFingerprint } from "../llm/file-pipeline.js";
import type { DependencyDoc } from "../llm/file-writer.js";
import type { ProjectIndex } from "../types.js";

/** Names declared in each dependency's file, so a block naming one of them counts as leaning on that doc. */
export function mentionCandidatesFor(docs: DependencyDoc[], index: ProjectIndex): MentionCandidate[] {
  return docs.map((doc) => ({
    sourcePath: doc.sourcePath,
    names: [
      ...new Set(
        Object.values(index.code.entities)
          .filter((entity) => entity.path === doc.sourcePath && entity.id.startsWith("symbol:"))
          .map((entity) => entity.name.split(".").pop())
          .filter((name): name is string => name !== undefined)
      ),
    ],
  }));
}

/**
 * Hash of the dependency docs a single block's prose names, or of none when it names
 * none. The section-level fingerprint hashes every dependency of the file and so
 * cannot say whether a given block leaned on the one that moved; this can.
 */
export function blockDepDocsFingerprint(body: string, docs: DependencyDoc[], candidates: MentionCandidate[]): string {
  const named = new Set(mentionedDependencies(body, candidates));
  return dependencyDocsFingerprint(docs.filter((doc) => named.has(doc.sourcePath)));
}
