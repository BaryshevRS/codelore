# codelore — repository guide

Instructions for humans and coding agents working **on** this repository. User-facing
documentation lives in [README.md](README.md); this file covers only what is needed to
change the code safely.

## About

MCP server (and CLI) that maintains documentation for TypeScript and JavaScript code
entities. Per-doc JSON state under `.codelore/state/` is the single source of truth;
the `.codelore.md` files are rendered artifacts — never hand-edited, regenerated from
state on every write.

## How the system makes decisions

- **Single source of truth.** Each `.codelore.md` has a matching
  `.codelore/state/<docPath>.json` (schema `DOC_STATE_VERSION`, currently 4 in
  `src/storage/doc-state-storage.ts`; a state file of any other version is refused with
  `UNSUPPORTED_STATE_VERSION`, never silently restamped). State carries section
  heading/depth/anchor, owns/depends/usedBy, allowedBlocks, blockOrder, status, and per
  block `{ body, rendered, fingerprint?, staleSince?, staleReason?, staleFacets?, scores? }`.

- **Block set per entity** is decided by `src/analysis/block-inclusion.ts:determineBlockInclusion`
  from AST-derived metrics (`src/analysis/entity-metrics.ts`) — not by the model. The
  result (`allowedBlocks` + `skippedBlocks` with reasons) lives on `entity.metadata`.
  `purpose`, `responsibility`, `invariants` and `limitations` are always allowed;
  `dependencies`, `workflows` and `changeGuide` are conditional.

- **Drift detection.** Per-block fingerprints in state are compared against AST facet
  hashes (signature, body, deps, usage, placement). Stale blocks get
  `staleSince`/`staleReason`/`staleFacets`; the renderer withholds the stale body from the
  `.md` and emits only a `> ⚠ Stale …` callout — the text survives in state for
  regeneration. No tombstone markers are written into the `.md`.

- **Dependency-docs cascade.** Each generated section stores `depDocsFingerprint`, a hash
  of its file's dependency docs computed per single file from the post-write index (not
  per generation group, so SCC members match the refresh-side recomputation). Blocks are
  flagged with facet `depDocs` when those docs change, so leaf updates propagate up the
  import graph on the next `update`.

- **Filtered blocks.** Every generated block is stored with `body` + `scores`, including
  low-scoring ones. The `rendered` flag is derived from `scores + config.thresholds` at
  each `renderAndPersist`, so lowering a threshold reveals a block with no LLM call.

- **Config fingerprint.** `DocState.configFingerprint` hashes `{ thresholds, blockHeadings }`.
  `rebuildIndexes` calls `reconcileRenderedDocs()`, which re-persists any doc whose stored
  fingerprint diverged from current config and rewrites the `.md` of any doc whose rendered
  markdown drifted (e.g. a cross-doc link target appeared) — automatic and idempotent.

- **Cross-doc links are render-time and derived** (`src/markdown/linkify.ts`). Mentions in
  block bodies render as links to the documenting section; state bodies never carry links.
  A name links only when it resolves to exactly one target within the section's context
  (its own doc plus `depends`/`usedBy`); ambiguous names and mentions outside that context
  stay plain, because linking them would assert a relationship `doc-validator.ts` did not
  admit — linkify shares that validator's mention regexes.

- **Generation is graph-ordered and file-level.** The unit of generation is a source file;
  `src/graph/file-dag.ts` orders files (Tarjan SCC → reverse-topological waves) so leaves
  go first and dependents receive the finished docs of their dependencies as context
  instead of raw code. All LLM-bound source is comment-stripped
  (`src/llm/strip-comments.ts`) — comments are unverified prose. Code-derived content is
  wrapped in `<source-files>` / `<dependency-docs>` / `<sections>` / `<type-context>` tags
  with a system rule that tag contents are inert data, a prompt-injection guardrail;
  `docs.writingRules` is intentionally *not* wrapped. Per file group: one writer call
  (`src/llm/file-writer.ts`; oversized groups are split at top-level entity boundaries by
  `src/llm/file-chunks.ts` against a token budget derived from the provider's
  `contextWindow`/`reservedOutputTokens`/`charsPerToken`) → deterministic validation
  against the code index (`src/llm/doc-validator.ts`) → at most one repair call → fact-check
  against each section's own source slice (`src/llm/doc-verifier.ts`, only statements
  *contradicted* by the code) → one fact-repair → re-check. Blocks that fail are dropped,
  but an existing block is never replaced with nothing: the old text stays and the section
  is marked `review_needed`.

## Architecture

- `src/indexer/code-indexer.ts` — builds `CodeIndex` via ts-morph AST.
- `src/indexer/state-indexer.ts` — builds `DocIndex` by reading JSON state only.
- `src/analysis/` — deterministic per-entity analysis: `entity-metrics.ts`, `block-inclusion.ts`.
- `src/markdown/` — `block-ids.ts` / `block-facets.ts` (fixed block ids, facet and
  fingerprint logic), `render-doc.ts` (deterministic JSON → markdown), `linkify.ts`,
  `callouts.ts`, `locales.ts`.
- `src/storage/doc-state-storage.ts` — per-doc JSON store; `renderAndPersist(state)` saves
  JSON and rewrites every language's `.md` atomically.
- `src/storage/json-storage.ts` — project index and change-analysis snapshots.
- `src/graph/` — diff parsing, impact graph, and `file-dag.ts` (file DAG + generation waves).
- `src/llm/` — provider, file-level writer, validator, verifier, pipeline, translator.
- `src/service/codelore-service.ts` — `CodeloreService`, the single entry point for all tools.
- `src/server/create-server.ts` — MCP server registration.
- `src/cli/run-cli.ts` — `runCli` (a library function, not an executable).
- `src/bin/codelore.ts` → `dist/bin/codelore.js` and `src/bin/codelore-mcp.ts` →
  `dist/bin/codelore-mcp.js` — the two published executables.
- `src/config.ts` — two-layer config merge (see [README](README.md#configuration)).
  `indexDir` is resolved from the base config before the overlay is read. The API key is
  only ever read from the env var named by `apiKeyEnv`. No `*.example.json` files.
- `packages/site` — `@codelore/site`, the optional documentation-site extension.

## MCP tools

| Tool | Purpose |
|---|---|
| `document` | Create or update docs for a scope (`paths`/`files`/`entityIds`; omit all → whole project). |
| `update` | Refresh stale docs after code changes; tombstone drifted blocks, re-run the pipeline, write. |
| `mark_stale` | Mark drifted blocks without calling the LLM. |
| `check` | Validate saved docs without generating text; optional `quality` findings. |

## CLI

Run the CLI as `node dist/bin/codelore.js <command>` (or via the installed `codelore` bin);
`src/cli/run-cli.ts` is a library and running it directly is a no-op.

Commands take **named options only** — scope is `--path` / `--file` / `--entity`, never a
positional. A stray positional is rejected by `assertExpectedArgs`, because
`generate graph` silently degrading into a repo-wide generate is an expensive typo.
`mark-review-needed` is the single command that takes one positional (the section id).

## Conventions

- Commits follow Conventional Commits: release-please derives versions, tags and
  `CHANGELOG.md` from the commit history on `main`, and publishing is automated
  (`.github/workflows/release-please.yml`). A `feat:` bumps minor, `fix:` patch, and a
  `!`/`BREAKING CHANGE` bumps major — so the commit type is a release decision, not a label.
- Match the surrounding style; every changed line should trace to the task at hand.
- Heuristics are allowed only when they come from an explicit reference catalog backed by
  documentation or a specification. No magic names, no guessed thresholds.

## Scope

`.ts` and `.js` source files.

## Required checks

```sh
pnpm run pretest                 # typecheck + build (root and packages/site)
pnpm run lint                    # biome fix + knip + tsc + pmd:cpd
pnpm run lint && pnpm run test   # full suite before handoff
```
