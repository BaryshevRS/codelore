# waves.ts

## Зачем это нужно

The module turns a file dependency graph into ordered waves of entities, supporting two grouping strategies — by dependency depth and by strongly connected components — and provides the underlying strongly-connected-component extraction used by one of them.

## Что делает

dependencyWaves groups the in-scope files into waves based on dependency depth, and stronglyConnectedComponents groups the in-scope files into strongly connected components (cycles). Both functions return each group as an array of node names. The module also exports the stronglyConnectedComponents helper, which is used internally by dependencyWaves to compute the depth-based grouping.

## Чего не делает

The module only groups files that are in scope; files outside the scope are ignored.

# dependencyWaves

```ts
dependencyWaves(graph: DepGraph, scope: ReadonlySet<string>): string[][][]
```

## Зачем это нужно

dependencyWaves produces a topologically ordered list of entity waves from a file DAG, so that consumers can process entities in dependency order.

## Что делает

dependencyWaves groups the in-scope files into waves based on dependency depth using the stronglyConnectedComponents helper, and returns each group as an array of node names.

## На что можно положиться

The returned waves are ordered by dependency depth: the first wave contains files with no external dependencies, and each subsequent wave contains files whose external dependencies are all in earlier waves. The function does not mutate the input graph or the node set.

## От чего зависит

The function depends on the stronglyConnectedComponents helper from the same module.

## Кто и как использует

The function is called by consumers that need to process entities in dependency order, such as a build or analysis pipeline. The caller can rely on the returned waves to be topologically ordered, so it can process each wave only after all its dependencies have been processed.

## Чего не делает

The function only processes files that are in scope; files outside the scope are ignored.

## Как менять и что проверять

- The wave ordering is enforced by the depth computation that uses stronglyConnectedComponents to find cycles.
- The non-mutation guarantee is enforced by the function not modifying the input graph or node set.

# stronglyConnectedComponents

```ts
stronglyConnectedComponents(scope: ReadonlySet<string>, graph: DepGraph): string[][]
```

## Зачем это нужно

stronglyConnectedComponents extracts the strongly connected components (cycles) from a file DAG, which is the building block that dependencyWaves uses to compute dependency-depth waves.

## Что делает

stronglyConnectedComponents computes the strongly connected components of the DAG using a standard algorithm (e.g., Tarjan's) and returns them as an array of arrays of file paths. Each component is a maximal set of files where every file is reachable from every other file in the set.

## На что можно положиться

The function returns an array of strongly connected components, each represented as an array of file paths. The order of components and the order of paths within each component follow the DAG's internal iteration order, so the result is deterministic for a given DAG. The function does not modify the input DAG.

## Кто и как использует

The function is called by dependencyWaves to compute the depth-based grouping, and can also be called directly by consumers that need to identify cycles in the dependency graph. The caller can rely on the returned components to be maximal and deterministic for a given DAG.

## Чего не делает

The function only processes files that are in scope; files outside the scope are ignored.

## Как менять и что проверять

- The deterministic ordering is enforced by the algorithm following the DAG's internal iteration order.
- The maximality of each component is enforced by the standard algorithm (e.g., Tarjan's) that computes strongly connected components.
