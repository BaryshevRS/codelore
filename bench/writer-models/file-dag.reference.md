# file-dag.ts

`file-dag.ts` builds a file-level dependency graph from a `CodeIndex` and uses it to order files for generation.

## Purpose

The module converts entity-level direct dependencies into file-level dependencies:

- each key in the graph is a project file from `code.fileToEntities`;
- each value is the set of other project files that file depends on;
- dependencies inside the same file are ignored;
- dependency IDs that do not resolve to known entities are ignored;
- dependencies whose target file is not in the file graph are ignored.

The resulting graph is used to split files into generation waves where dependencies are scheduled before dependents.

## Exports

### `FileDag`

```ts
export type FileDag = Map<string, Set<string>>;
```

Represents `file -> dependency files`.

### `buildFileDag(code: CodeIndex): FileDag`

Builds a `FileDag` from `CodeIndex`.

The function first creates an empty dependency set for every file listed in `code.fileToEntities`. It then walks all entities in `code.entities`, reads each entity's `directDeps`, resolves those dependency IDs back to entities, and records cross-file dependencies.

The function is defensive around missing data:

- if an entity path is not present in the DAG, the entity is skipped;
- if a direct dependency ID does not resolve to an entity, it is skipped;
- if a dependency resolves to the same file as the source entity, it is skipped.

### `generationWaves(code: CodeIndex, files: string[]): string[][][]`

Orders a requested file scope for generation.

The return shape is:

```ts
string[][][]
// wave -> groups in that wave -> files in that group
```

Each innermost group is a strongly connected component. A group can contain one file, or multiple files when the files form a dependency cycle. Files in the same group are sorted alphabetically.

Only requested files that exist in the DAG are included:

```ts
const scope = new Set(files.filter((file) => dag.has(file)));
```

Files outside the requested scope can exist in the DAG, but they do not become groups in the result. When calculating levels, only dependencies whose files are also in the scoped groups affect wave placement.

## Wave Ordering

`generationWaves` computes strongly connected components over the scoped subgraph, then assigns each component a level:

- a component with no scoped dependencies is level `0`;
- a component that depends on a component at level `N` becomes at least level `N + 1`;
- dependency cycles stay in one component, so recursion does not cross within the same cycle.

The final result groups components by level. Lower-level waves come first, which means dependency groups appear before groups that depend on them.

Within each wave, groups are sorted by the first file name in each group:

```ts
wave.sort((left, right) => left[0].localeCompare(right[0]));
```

## Cycle Handling

Cycles are handled by `stronglyConnectedComponents`, an iterative Tarjan implementation over the subgraph induced by the requested scope.

The implementation avoids recursive traversal by keeping explicit work frames:

```ts
Array<{ file: string; neighbors: string[]; neighborIndex: number }>
```

For each file, it tracks:

- `index`: first-visit order;
- `lowLink`: the lowest reachable active index;
- `stack`: active traversal stack;
- `onStack`: files currently in the active SCC search.

When a file's `lowLink` equals its `index`, the function pops one complete component from the stack.

## Determinism

The module sorts traversal inputs to keep output stable:

- SCC roots are processed as `[...]scope].sort()`;
- neighbors are filtered to scope and sorted;
- files inside each group are sorted before returning;
- groups inside a wave are sorted by their first file.

This makes generation waves independent of insertion order in most observable places.

## Notable Behavior

- Empty or fully unknown input scope returns an empty wave list.
- Duplicate file names in `files` are collapsed by the scoped `Set`.
- A self-contained cycle is returned as one group in a single wave.
- Cross-file dependencies are recorded once per dependency file because each graph edge is stored in a `Set`.
