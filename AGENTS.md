# codelore

## About

MCP server that maintains documentation for TypeScript and JavaScript code entities. Per-doc JSON state under `.codelore/state/` is the single source of truth; the `.codelore.md` files are rendered artifacts (no metadata comments, no manual edits).

## Runtime context rule

No hardcoded heuristics. Heuristics are allowed only when they come from an explicit reference catalog backed by documentation or a specification.

## How the system makes decisions

- **Single source of truth.** Each `.codelore.md` has a matching `.codelore/state/<docPath>.json` (schema version 2). State carries: section heading/depth/anchor, owns/depends/usedBy, allowedBlocks, blockOrder, status, and per block `{ body, rendered, fingerprint?, staleSince?, staleReason?, staleFacets?, scores? }`. `.md` is regenerated from state on every write.

- **Block set per entity** is decided by `src/analysis/block-inclusion.ts:determineBlockInclusion` from AST-derived metrics (`src/analysis/entity-metrics.ts`). Result — `allowedBlocks` + `skippedBlocks` with reasons — lives on `entity.metadata`.
    - Always allowed: `purpose`, `responsibility`, `invariants`, `limitations`.
    - Conditional: `dependencies` (entity has internal deps / used globals / non-stdlib imports), `workflows` (`inDegree > 0` or entry point), `changeGuide` (`decision.role === "full_page"`).

- **Drift detection.** `refresh-stale` compares per-block fingerprints (stored in JSON state) against AST facet hashes (signature, body, deps, usage, placement). Stale blocks get `staleSince`/`staleReason`/`staleFacets` in state; the renderer emits a `> ⚠ Stale …` callout above the block body. No tombstone markers are stored in the `.md`.

- **Filtered blocks.** All `generatedBlocks` (incl. low-score ones) are stored in state with `body` + `scores`. The `rendered` flag is **derived** from `scores + config.thresholds` at every `renderAndPersist` call. Lowering thresholds → next render shows the block, no LLM needed.

- **Config fingerprint.** `DocState.configFingerprint` is a hash of `{ thresholds, blockHeadings }`. `renderAndPersist` writes the current fingerprint. `rebuildIndexes` calls `reapplyConfigToAllDocs()` which re-renders any doc whose stored fingerprint diverged from current config — automatic and idempotent.

- **LLM contract (variant B).** `get_section_context` returns the full section JSON (all blocks visible as read-only context). LLM returns `generatedBlocks` for the targets only. Service merges into state, recomputes fingerprints, clears stale markers, and re-renders `.md`.

## Architecture

- **`src/indexer/code-indexer.ts`** — builds `CodeIndex` via ts-morph AST.
- **`src/indexer/state-indexer.ts`** — builds `DocIndex` by reading JSON state from `.codelore/state/` only.
- **`src/analysis/`** — deterministic per-entity analysis: `entity-metrics.ts`, `block-inclusion.ts`.
- **`src/markdown/render-doc.ts`** — deterministic JSON → markdown renderer.
- **`src/markdown/block-ids.ts`** / **`block-facets.ts`** — fixed `BLOCK_IDS` and facet/fingerprint logic.
- **`src/storage/doc-state-storage.ts`** — per-doc JSON store; `renderAndPersist(state)` saves JSON and rewrites `.md` atomically.
- **`src/service/codelore-service.ts`** — `CodeloreService`: the single entry point for all MCP tools.
- **`src/graph/`** — diff parsing and impact graph.
- **`src/llm/`** — LLM provider + section-block generator.
- **`src/server/create-server.ts`** — MCP server registration.
- **`src/cli/run-cli.ts`** — `runCli` function (library, NOT an executable; running it directly is a no-op).
- **`src/bin/codelore.ts`** → **`dist/bin/codelore.js`** — actual CLI entry point. Always run the CLI via `node dist/bin/codelore.js <command>` (or the `codelore` bin from `package.json`).
- **`src/storage/json-storage.ts`** — project index + change analysis snapshots.

## CLI usage traps

- Before running a mutating CLI command, verify its argument contract from `node dist/bin/codelore.js help` or `src/cli/run-cli.ts` if there is any ambiguity.
- `generate` does **not** accept a positional file path as scope. Use named scope options only:
    - `node dist/bin/codelore.js generate --file src/storage/json-storage.ts`
    - `node dist/bin/codelore.js generate --path src/storage`
    - `node dist/bin/codelore.js generate --entity <entityId>`
- Never run `node dist/bin/codelore.js generate <path>` expecting it to target that path. The positional path is ignored by the current parser, causing an unscoped project-wide generate.

## MCP tools

| Tool | Purpose |
|---|---|
| `document` | Create or update docs for a scope (`paths`/`files`/`entityIds`; omit all → whole project). Runs the full LLM pipeline and writes JSON state + rendered `.md`. |
| `update` | Refresh stale docs after code changes (`paths`/`files`/`sectionIds`; omit all → every stale block). Tombstones drifted blocks, re-runs the pipeline, writes refreshed docs. |
| `mark_stale` | Mark drifted blocks without calling the LLM (`paths`/`files`/`sectionIds`; omit all → every drifted block). |
| `check` | Validate saved docs without generating text: broken metadata links, stale/empty/TODO blocks, optional `quality` findings. |

## Scope

V1 supports `.ts` and `.js` source files only.

## Required checks

```
pnpm run pretest   # typecheck + build
pnpm run lint      # biome fix + knip + tsc + pmd:cpd
pnpm run lint && pnpm run test   # full suite before handoff
```
