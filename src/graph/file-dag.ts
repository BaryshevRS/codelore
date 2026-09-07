import type { CodeIndex } from "../types.js";
import { type DepGraph, dependencyWaves } from "./waves.js";

/** file → set of project files it depends on (via entity directDeps). */
export type FileDag = DepGraph;

export function buildFileDag(code: CodeIndex): FileDag {
  const dag: FileDag = new Map();
  for (const file of Object.keys(code.fileToEntities)) {
    dag.set(file, new Set());
  }
  for (const entity of Object.values(code.entities)) {
    const deps = dag.get(entity.path);
    if (!deps) {
      continue;
    }
    for (const depId of entity.directDeps) {
      const depEntity = code.entities[depId];
      if (depEntity && depEntity.path !== entity.path && dag.has(depEntity.path)) {
        deps.add(depEntity.path);
      }
    }
  }
  return dag;
}

/**
 * Orders files for generation: dependencies before dependents. Returns waves;
 * each wave is a list of groups (an SCC — a dependency cycle — is one group).
 * Files within a wave have all their dependencies in earlier waves, so a wave can
 * be processed in parallel. Edges to files outside `files` are invisible to the
 * wave layout (they are not in the induced scope).
 */
export function generationWaves(code: CodeIndex, files: string[]): string[][][] {
  const dag = buildFileDag(code);
  const scope = new Set(files.filter((file) => dag.has(file)));
  return dependencyWaves(dag, scope);
}
