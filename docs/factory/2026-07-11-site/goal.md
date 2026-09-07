# Goal Contract — Codelore site package

> Source of truth. Agents may propose **Goal Amendments**; they may not silently rewrite this.

## Core

### Current state

- `@codelore/mcp` generates colocated `.codelore.md` artifacts but has no documentation-site export.
- The repository is a single pnpm package, so an extension package cannot be developed or checked independently.

### Desired future state

- `@codelore/site` is a workspace extension with a neutral `codelore-site` CLI.
- `init` creates a Fumadocs-backed Next.js site and `sync` mirrors canonical Codelore documentation into its content directory.
- Re-running `sync` updates only extension-owned content and preserves scaffold customizations.

### Desired outcomes

- A documented Codelore project can create and build a browsable local docs site without manual Markdown copying.
- Generated internal links resolve to the corresponding site routes and preserve anchors.
- The main package and the extension both retain their existing quality gates.

### Smallest shippable slice

Create the workspace package, a `codelore-site init --root <dir> --output <dir>` CLI, and deterministic `sync` for canonical `.codelore.md` files into a generated Fumadocs Next.js app. Sync reads the versioned state envelope only to enumerate its `docPath`, so it stays compatible with the project's current schema. V1 has one internal Fumadocs implementation and no i18n routing.

### Stop condition

Stop and ask for a re-scope if the generated Fumadocs app cannot be built from a clean fixture using current documented APIs, or if supporting translations requires changing Codelore's state schema or renderer contract.

### Success evidence

- Unit tests prove route mapping, frontmatter/heading adaptation, link rewriting, and orphan cleanup.
- An integration test runs `init` against a fixture and verifies the generated app structure and mirrored content.
- `pnpm run lint && pnpm run test` passes for the workspace.
- The generated Fumadocs app passes its production build.

### Risk classification

R1 internal dev-assist. EU AI Act: Art 5 prohibited use? no. Art 50 labelling? N/A.

### Tracker

none

## Conditional

### Non-goals

- Fumadocs branding in Codelore's public package name or CLI.
- Fumadocs i18n routing and publishing/deployment automation.
- A generic multi-framework adapter system.
- Moving `@codelore/mcp` out of the repository root.

### Visual checkpoints

One generated documentation page at a desktop viewport after the production build.

### Rollback note

Revert the extension package and workspace manifest; the existing root package remains independently buildable.

---
**Fail rule:** if a goal can't produce evidence, it's a wish with better formatting — it doesn't pass.
