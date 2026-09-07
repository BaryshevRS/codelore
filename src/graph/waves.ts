/** A directed graph: node → set of nodes it depends on. */
export type DepGraph = Map<string, Set<string>>;

/**
 * Orders a dependency graph into waves: dependencies before dependents. Each wave
 * is a list of groups; a group is a strongly connected component (a dependency
 * cycle collapses to one group). A group's wave is one past the highest wave of any
 * group it depends on, so every group in a wave has all its dependencies in earlier
 * waves and the wave can be processed in parallel. Output is deterministic: files
 * within a group and groups within a wave are sorted.
 */
export function dependencyWaves(graph: DepGraph, scope: ReadonlySet<string>): string[][][] {
  const groups = stronglyConnectedComponents(scope, graph);

  const groupOfNode = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    for (const node of groups[i]) {
      groupOfNode.set(node, i);
    }
  }

  const levels = new Array<number>(groups.length).fill(-1);
  const levelOf = (groupIndex: number): number => {
    if (levels[groupIndex] >= 0) {
      return levels[groupIndex];
    }
    levels[groupIndex] = 0;
    let level = 0;
    for (const node of groups[groupIndex]) {
      for (const dep of graph.get(node) ?? []) {
        const depGroup = groupOfNode.get(dep);
        if (depGroup !== undefined && depGroup !== groupIndex) {
          level = Math.max(level, levelOf(depGroup) + 1);
        }
      }
    }
    levels[groupIndex] = level;
    return level;
  };

  const waves: string[][][] = [];
  for (let i = 0; i < groups.length; i++) {
    const level = levelOf(i);
    while (waves.length <= level) {
      waves.push([]);
    }
    waves[level].push([...groups[i]].sort());
  }
  for (const wave of waves) {
    wave.sort((left, right) => left[0].localeCompare(right[0]));
  }
  return waves;
}

/** Iterative Tarjan over the subgraph induced by `scope`. */
export function stronglyConnectedComponents(scope: ReadonlySet<string>, graph: DepGraph): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const neighborsOf = (node: string): string[] => [...(graph.get(node) ?? [])].filter((dep) => scope.has(dep)).sort();

  for (const root of [...scope].sort()) {
    if (index.has(root)) {
      continue;
    }
    const work: Array<{ node: string; neighbors: string[]; neighborIndex: number }> = [
      { node: root, neighbors: neighborsOf(root), neighborIndex: 0 },
    ];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const { node } = frame;
      if (frame.neighborIndex === 0) {
        index.set(node, counter);
        lowLink.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const next = frame.neighbors[frame.neighborIndex];
      if (next !== undefined) {
        frame.neighborIndex++;
        if (!index.has(next)) {
          work.push({ node: next, neighbors: neighborsOf(next), neighborIndex: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(node, Math.min(lowLink.get(node) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) ?? 0, lowLink.get(node) ?? 0));
      }
      if (lowLink.get(node) === index.get(node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member !== undefined) {
            onStack.delete(member);
            component.push(member);
          }
        } while (member !== undefined && member !== node);
        components.push(component);
      }
    }
  }
  return components;
}
