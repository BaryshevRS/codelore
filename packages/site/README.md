# @codelore/site

Generate a browsable documentation site from Codelore's rendered artifacts.

```sh
pnpm dlx @codelore/site init --root . --output apps/docs
pnpm --dir apps/docs install
pnpm --dir apps/docs build
```

Refresh generated content after Codelore updates documentation:

```sh
pnpm dlx @codelore/site sync --root . --output apps/docs
```

Only files listed in `apps/docs/.codelore-site/content-manifest.json` are
managed by `sync`; user-created content is left untouched.
