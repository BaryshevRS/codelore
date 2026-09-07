import type { CodeIndex } from "../types.js";
import { buildFileDag } from "./file-dag.js";
import type { DepGraph } from "./waves.js";

/**
 * Quotient of the file DAG by domain: domain A depends on domain B when a file in
 * A depends on a file in B (A ≠ B). `fileToDomain` maps a file to its domain slug;
 * files absent from it (unassigned) are ignored — they carry no domain edges.
 * Intra-domain deps are dropped. Every domain named as a value gets an entry, even
 * with no edges.
 */
export function buildDomainDag(code: CodeIndex, fileToDomain: ReadonlyMap<string, string>): DepGraph {
  const dag: DepGraph = new Map();
  for (const slug of fileToDomain.values()) {
    if (!dag.has(slug)) {
      dag.set(slug, new Set());
    }
  }
  for (const [file, deps] of buildFileDag(code)) {
    const from = fileToDomain.get(file);
    if (from === undefined) {
      continue;
    }
    const edges = dag.get(from);
    if (!edges) {
      continue;
    }
    for (const dep of deps) {
      const to = fileToDomain.get(dep);
      if (to !== undefined && to !== from) {
        edges.add(to);
      }
    }
  }
  return dag;
}
