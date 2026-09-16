# Changelog

## [1.2.0](https://github.com/BaryshevRS/codelore/compare/@codelore/mcp@1.1.0...@codelore/mcp@1.2.0) (2026-09-15)


### Features

* **cli:** narrow a generation run to named blocks and let it skip the fact-check ([d2170b2](https://github.com/BaryshevRS/codelore/commit/d2170b23678bbec66cc8720e0a629e0fe48dbd7d))
* **docs:** render ARCHITECTURE.md from the documentation state ([e69ce34](https://github.com/BaryshevRS/codelore/commit/e69ce34f4f419e8dfe5f7954b3997c4a09bbc141))
* **mcp:** add a locate tool so an agent can find documented code ([7d5f8b5](https://github.com/BaryshevRS/codelore/commit/7d5f8b55c94ad2c8e5adf015aee508b22793d617))
* **mcp:** answer from the call graph, and stop restating small files ([28e1709](https://github.com/BaryshevRS/codelore/commit/28e17091fdbbbd62e1badb4776fdb60245f0aaf9))
* **mcp:** put the read rule where a client gets it without asking ([1c7a784](https://github.com/BaryshevRS/codelore/commit/1c7a784e4cc22c05eb5183746dbc43e78a862d95))
* **mcp:** tell a caller what it must not break in code it is about to change ([43ed5a7](https://github.com/BaryshevRS/codelore/commit/43ed5a72c1ff38dcda13369da90c1f722aba7e83))

## [1.1.0](https://github.com/BaryshevRS/codelore/compare/@codelore/mcp@1.0.1...@codelore/mcp@1.1.0) (2026-09-14)


### Features

* **analysis:** read a block's real dependencies out of its own prose ([9fba04d](https://github.com/BaryshevRS/codelore/commit/9fba04d7077e08f2aa24de490a7d7612c72e9e75))
* **cli:** time every model call ([2554a53](https://github.com/BaryshevRS/codelore/commit/2554a53d18ef6f811d10cb97b941fa648b26f210))
* **stale:** invalidate a block by the dependencies it names, not by the file's ([f81bdc5](https://github.com/BaryshevRS/codelore/commit/f81bdc54fb26250847c0a56d7e55b71a491df15d))


### Bug Fixes

* **llm:** refuse an answer the model did not finish ([782bbbe](https://github.com/BaryshevRS/codelore/commit/782bbbe98048984b7cee0657effdcbd06ec64291))
* **llm:** retry an empty stream instead of dropping the work ([68e3c4a](https://github.com/BaryshevRS/codelore/commit/68e3c4a2c5d066f0babfbad2b6c1b1671052dbf7))
* **stale:** stop invalidating docs over comments the writer never sees ([3bfefbe](https://github.com/BaryshevRS/codelore/commit/3bfefbec01f2b07b7e6a6bae5ac479390c60a5af))
* **update:** a failed dependency check no longer fails the whole run ([ecc6dd8](https://github.com/BaryshevRS/codelore/commit/ecc6dd8b7b1e3ab2e7dcfd85b3db70415e763a4b))
* **update:** converge in one run and assign uncovered files ([9b89c6c](https://github.com/BaryshevRS/codelore/commit/9b89c6c8ab721739d2b88b4f70ef259f5c5874e4))


### Performance Improvements

* **llm:** stop paying for hidden reasoning tokens on every call ([b791f85](https://github.com/BaryshevRS/codelore/commit/b791f85eea83e031d23f86c60c264a104732ccf0))

## [1.0.1](https://github.com/BaryshevRS/codelore/compare/@codelore/mcp@1.0.0...@codelore/mcp@1.0.1) (2026-09-13)


### Documentation

* **readme:** badge the published npm version ([da7c17b](https://github.com/BaryshevRS/codelore/commit/da7c17baeff099290e477b83cd22751fe8401a6c))
