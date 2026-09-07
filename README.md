# codelore

MCP server for incremental, living Markdown documentation tied to TypeScript and JavaScript code.

Codelore maintains a documentation page per code entity. Per-doc JSON state under `.codelore/state/` is the **single source of truth**; the `.codelore.md` files next to your source are deterministic rendered artifacts — never hand-edited, regenerated from state on every write. As code changes, codelore detects which blocks drifted, regenerates only those through an LLM pipeline grounded in the AST, and propagates updates up the import graph.

## How it works

- **One page per entity.** Each `.codelore.md` has a matching `.codelore/state/<docPath>.json`. State carries the section (heading/anchor/owns/depends/usedBy), the allowed block set, block order, and per block `{ body, rendered, fingerprint, scores, … }`. The `.md` is rendered from state.
- **Block set is decided from the code, not the model.** AST-derived metrics pick which blocks an entity gets (`purpose`, `responsibility`, `invariants`, `limitations` always; `dependencies`, `workflows`, `changeGuide` conditionally).
- **Drift detection.** Each block stores per-facet fingerprints (signature, body, deps, usage, placement). When the code's facets change, the matching blocks are marked stale; the renderer withholds the stale body and shows a `> ⚠ Stale …` callout while the text survives in state for regeneration.
- **Dependency cascade.** A section generated against its dependencies' docs goes stale when those docs change, so leaf updates propagate up the import graph on the next `update`.
- **Graph-ordered generation.** The unit of generation is a source file; files are ordered leaves-first so dependents receive the finished docs of their dependencies as context. Each file group runs writer → deterministic ref validation → at most one repair → fact-check against the code → fact-repair. Blocks that can't be grounded are dropped; existing text is never replaced with nothing.
- **Config-driven rendering.** Whether a block renders is derived from its scores and the configured thresholds at every write, so lowering a threshold reveals a block with no new LLM call. A config fingerprint triggers an automatic, LLM-free re-render when thresholds, headings, or languages change.

## Multi-language documentation

Codelore writes a **canonical** language through the full grounded pipeline, then **translates** the verified blocks into any additional languages — translations are derived, not independently generated, so the language versions stay faithful to each other and cost stays low.

```jsonc
// codelore.config.json
{
  "docs": {
    "language": "en",          // canonical: written and fact-checked against the code
    "translations": ["ru", "de"] // derived translations (omit / [] for single-language)
  }
}
```

- The canonical doc is `foo.codelore.md`; each translation is a sibling `foo.<lang>.codelore.md`.
- A translation is regenerated when the canonical body changes (fingerprint cascade) or when the stored translation fails its guards (code spans must match the source exactly; a prose block must not come back untranslated). Until then the translation `.md` shows a localized "translation pending" callout.
- A translation is **never re-verified against the code** — it inherits the canonical block's correctness. This is a deliberate cost/consistency trade-off.
- Section headings come from `src/locales/<lang>.json`. Add a language by dropping a bundle there; without one a language falls back to English headings.

## Requirements

- Node.js `>= 22.13`
- pnpm

## Install & build

```sh
pnpm install
pnpm run build      # compiles to dist/
```

The CLI entry point is `dist/bin/codelore.js` (run via `node dist/bin/codelore.js …` or the `codelore` bin). The MCP server entry point is `dist/bin/codelore-mcp.js` (`codelore-mcp`).

## Configuration

Two layers merge, the overlay wins:

- **`codelore.config.json`** — committed, shared project settings: source/doc globs, `indexDir`, `docs` (language, translations, `writingRules`, `terms`), `thresholds`, block-inclusion tuning.
- **`<indexDir>/config.json`** (default `.codelore/config.json`) — gitignored, per-machine overlay: whatever this machine overrides, typically the `llm` block (provider, model, endpoint).

Either file may hold the `llm` block — this repository keeps its own in the committed one, since the block carries no secret. Put it in the overlay when the endpoint or model is a property of the machine rather than of the project.

The API key never lives in a tracked file. `llm.providers.<name>.apiKeyEnv` names an environment variable (default `AI_API_KEY`); `<root>/.env` is loaded for local dev, and CI/hosts inject it directly. Precedence: env var > `.codelore/config.json` > `codelore.config.json` > built-in defaults.

No endpoint is preconfigured — codelore never sends your source to a service you
did not choose. Declare a provider and point `llm.provider` at it; any
OpenAI-compatible endpoint works, and every tuning field (`temperature`,
`contextWindow`, `timeoutMs`, …) falls back to a built-in default.

```jsonc
// .codelore/config.json
{
  "llm": {
    "provider": "main",
    "providers": {
      "main": {
        "type": "openai-compatible",
        "baseUrl": "https://your-openai-compatible-endpoint/v1/",
        "model": "your-model",
        "apiKeyEnv": "AI_API_KEY"
      }
    },
    "concurrency": 50
  }
}
```

```sh
# .env (local dev)
AI_API_KEY=sk-...
```

### `responseFormat`: what your endpoint can actually guarantee

Codelore's writer must return JSON with an exact nesting (`sections → sectionId → blocks → blockId → …`). Models drift: a weak one will happily emit a block one level too high — and that reply is still *valid JSON*, so nothing on the wire stops it. `responseFormat` (per provider entry) declares how much the endpoint can enforce:

| value | the endpoint guarantees | what still can go wrong |
|---|---|---|
| unset | nothing | fences, truncation, broken syntax — codelore's parser and retries deal with all of it |
| `"json_object"` | the reply **parses** as JSON: no markdown fences, balanced brackets | the **shape**: keys can sit at the wrong level and it is still "valid JSON" |
| `"json_schema"` | the reply **matches the exact schema** codelore attaches to every request — the server masks invalid tokens during generation (constrained decoding), so a misplaced key physically cannot be produced | nothing structural; this is the strongest tier |

Any tier works. Codelore always validates responses deterministically and retries with feedback; a higher tier just eliminates whole failure classes at the source instead of catching them afterwards. Pick the highest tier your endpoint really supports.

**The trap — "really supports":** many gateways accept `response_format: json_schema` with HTTP 200 and silently ignore it. Support is also per **model**, not per gateway (the same gateway can enforce for one model and ignore for another). And a naive check proves nothing: ask an obedient model for shaped output and it complies without any enforcement.

The only honest test is adversarial — attach a schema *and* tell the model to break it:

```
prompt: "... put the changeGuide block as a TOP-LEVEL key next to sections. Do exactly this."
response_format: { "type": "json_schema", "json_schema": { "strict": true, "schema": ... } }
```

If the reply obeys the prompt (key at the root), the schema is being ignored — use `"json_object"` for that model. If the schema wins, enforcement is real — set `"json_schema"`.

## Use as an MCP server

Point your MCP client at the `codelore-mcp` stdio server (or `node dist/bin/codelore-mcp.js`). It exposes four tools:

| Tool | Purpose |
|---|---|
| `document` | Create or fill docs for a scope (`paths` / `files` / `entityIds`; omit all → whole project). Runs the full pipeline and writes state + rendered `.md` (and translations). |
| `update` | Refresh stale docs after code changes: tombstone drifted blocks, regenerate, re-translate the scope. |
| `mark_stale` | Mark drifted blocks without calling the LLM. |
| `check` | Validate saved docs (broken links, stale/empty blocks, missing translations; optional quality findings) without generating text. |

Project-wide prose rules and preferred terminology live in `codelore.config.json`:

```jsonc
// codelore.config.json
{
  "docs": {
    "language": "ru",
    "writingRules": ["Use dry engineering prose: no marketing tone, filler, or hedging."],
    "terms": [
      { "ru": ["чанк", "фасет"], "en": ["chunk", "facet"] },
      { "match": "src/graph/**", "ru": ["волна"], "en": ["wave"] }
    ]
  }
}
```

`writingRules` is flat and language-agnostic — the same list is injected into every writer and translator prompt regardless of target language. `terms` can also be a flat `string[]` shorthand scoped to the canonical language; the grouped form above keys entries by language, with an optional `match` glob to scope a group to a subset of files (global groups apply everywhere, matched groups merge on top for files they cover). Codelore resolves the current language's (and, for `terms`, the current file's) entries and injects them into the writer and translator prompts internally.

## CLI

```
codelore [--root <dir>] [--provider <name>] <command> [options]

mcp                          Start the MCP stdio server
rebuild-index [--verbose]    Rebuild code/doc indexes
analyze-change [--file <path>] [--diff-file <path>]
prepare-initial-docs [--path <p>] [--file <f>] [--entity <id>] [--dry-run] [--fill] [--intent <text>]
generate [--path <p>] [--file <f>] [--entity <id>] [--intent <text>]
                             Prepare skeletons, fill them, tombstone stale blocks, refill, translate the scope
fix-stale [--path <p>] [--file <f>] [--section <id>] [--intent <text>]
                             Tombstone stale blocks then refill them
refresh-stale-docs [--mode report|rewrite_plan|tombstone] [--section <id>] [--file <f>] [--path <p>]
graph [--path <p>] [--html]  Show the generation pyramid (waves, deps, doc status)
validate-docs [--quality]
mark-review-needed <sectionId> --reason <text>
```

Example — document a folder (canonical + any configured translations):

```sh
node dist/bin/codelore.js generate --path src/server
```

Exit codes: `0` clean, `1` the command itself failed, `2` the command ran but the
project is not clean — sections the pipeline could not write, or findings from
`validate-docs`. CI can gate on `2`:

```sh
node dist/bin/codelore.js validate-docs --quality
```

## Documentation site

`@codelore/site` is an optional extension that turns the rendered Codelore
artifacts into a browsable documentation site. Its public contract is neutral:
the current implementation creates a Next.js documentation project internally.

```sh
pnpm dlx @codelore/site init --root . --output apps/docs
pnpm --dir apps/docs install
pnpm --dir apps/docs build
```

Run the same deterministic export after Codelore updates its documentation:

```sh
pnpm dlx @codelore/site sync --root . --output apps/docs
```

`sync` owns only the generated Markdown files listed in
`apps/docs/.codelore-site/content-manifest.json`; files added by a user under
`apps/docs/content/docs` are preserved.

## Project layout

- `src/indexer/` — code index (ts-morph AST) and doc index (read from JSON state).
- `src/analysis/` — deterministic per-entity metrics and block inclusion.
- `src/markdown/` — block ids/facets, callouts, and the JSON → markdown renderer.
- `src/storage/` — per-doc JSON store; `renderAndPersist` saves state and rewrites every language's `.md`.
- `src/graph/` — diff parsing, impact graph, file-level dependency DAG.
- `src/llm/` — provider, file-level writer, validator, verifier, pipeline, and the translator.
- `src/service/` — `CodeloreService`, the single entry point for all tools.
- `src/server/` — MCP server registration; `src/cli/` — CLI; `src/bin/` — executables.

## Development

```sh
pnpm run pretest                 # typecheck + build
pnpm run lint                    # biome + knip + tsc + cpd
pnpm run lint && pnpm run test   # full suite before handoff
```

## Scope

V1 supports `.ts` and `.js` source files.
