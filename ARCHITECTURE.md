# Архитектура

> Страница собрана codelore из состояния документации и перерисовывается при каждом прогоне — правьте документацию, а не этот файл.

## С высоты птичьего полёта

Codelore — это система автоматической генерации, верификации, обновления и перевода документации для кодовых баз TypeScript/JavaScript. Она принимает исходный код, анализирует его структуру, вычисляет метрики и роли сущностей, генерирует документацию через LLM-пайплайн, проверяет её на фактические противоречия, переводит на заданные языки и рендерит готовые Markdown-файлы. Система нужна, чтобы поддерживать документацию в актуальном состоянии без ручного труда, автоматически отслеживая изменения в коде и помечая устаревшие или непереведённые блоки.

Codelore владеет полным циклом обработки документации: строит индексы кода и документации, вычисляет метрики и роли сущностей, определяет, какие секции нужно пересобрать при изменении кода, генерирует документацию через LLM-пайплайн с повторными запросами при ошибках JSON, проверяет каждый блок на фактические противоречия, переводит блоки с проверкой целостности кодовых промежутков и рендерит итоговые Markdown-документы с локализованными заголовками и цитатами об устаревших или непереведённых блоках.

Рабочий процесс Codelore начинается с индексации кода: подсистема индексов строит кодовый и документационный индексы, а подсистема метрик вычисляет для каждой сущности метрики размера, связности и побочных эффектов, определяя роль документации и перечень включаемых Markdown-блоков. Затем подсистема обнаружения изменений парсит unified diff, находит прямо затронутые секции и рекурсивно добавляет зависимые. Далее LLM-пайплайн генерирует документацию для каждой группы файлов: разбивает исходный код на чанки, формирует запросы, парсит ответы с повторными запросами при ошибках JSON, проверяет каждый блок на фактические противоречия и исправляет их. После этого подсистема перевода переводит блоки на другие языки, сохраняя кодовые вставки. Наконец, рендеринг превращает состояние каждого документа в Markdown с локализованными заголовками и цитатами об устаревших или непереведённых блоках.

## Чего система не делает

Codelore не управляет жизненным циклом LLM-провайдера и не обрабатывает ошибки провайдера выше фабрики. Отпечатки блоков вычисляются только для owned-сущностей: если список owned пуст, возвращается undefined, что не позволяет отследить изменения для блоков без владельцев. Подсистема не добавляет новые секции документации: она только очищает и валидирует существующие, а для новых сущностей создаёт скелетные DocState с пустыми телами блоков. Это значит, что callers должны сами инициировать наполнение контентом на следующем этапе конвейера.

## Точки входа

- `src/bin/codelore-mcp.ts` — `codelore-mcp`
- `src/bin/codelore.ts` — `codelore`

## Карта кода

Подсистемы по слоям — каждая опирается на предыдущие:
1. Граф зависимостей и влияние изменений · Единый формат ошибок · Подготовка исходного контекста для LLM-верификации · Построение runtime-контекста из литералов · Хранилище индексов и анализа изменений
2. Визуализация графа файлов · Общие вспомогательные функции сервиса · Фабрика LLM-провайдера
3. Анализ метрик кода и решения о документировании · Валидация и факт-чекинг сгенерированной документации · Индексация кода и документации · Конфигурация проекта · Обнаружение устаревших блоков документации · Общие низкоуровневые утилиты · Отпечатки блоков документации · Пайплайн генерации документации файлов · Перевод документации · Подготовка первичной документации · Применение перезаписей секций · Разбор JSON-ответов LLM с повтором запроса · Рендеринг и локализация Markdown-документов · Согласование и валидация состояния документации · Управление индексом проекта · Фасад сервиса Codelore · Хранилище состояния документации
4. MCP-сервер Codelore
5. Точка входа CLI

### [Граф зависимостей и влияние изменений](docs/domains/change-impact-graph.codelore.md#граф-зависимостей-и-влияние-изменений)

Подсистема парсит unified diff в список изменённых файлов с ханками и диапазонами строк. По сущностному индексу строит файловый граф зависимостей, отбрасывая самоссылки и файлы вне индекса. Затем раскладывает выбранные файлы по волнам генерации: каждая волна содержит группы файлов, все зависимости которых лежат в более ранних волнах. По списку имён сущностей находит прямо затронутые секции (через owns/depends) и рекурсивно добавляет секции, зависящие от них, возвращая отсортированный результат с минимальным порядком.

[`src/graph/diff.ts`](src/graph/diff.codelore.md) · [`src/graph/domain-dag.ts`](src/graph/domain-dag.codelore.md) · [`src/graph/file-dag.ts`](src/graph/file-dag.codelore.md) · [`src/graph/impact.ts`](src/graph/impact.codelore.md) · [`src/graph/waves.ts`](src/graph/waves.codelore.md)

### [Единый формат ошибок](docs/domains/error-handling.codelore.md#единый-формат-ошибок)

[`src/errors.ts`](src/errors.codelore.md)

### [Подготовка исходного контекста для LLM-верификации](docs/domains/llm-source-context-prep.codelore.md#подготовка-исходного-контекста-для-llm-верификации)

Подсистема готовит для LLM очищенный от комментариев исходный код и контекст объявлений типов, прямо используемых в секциях документации. Результат — компактный синтаксический материал без шума, позволяющий модели сосредоточиться на верификации структуры и типов.

[`src/llm/strip-comments.ts`](src/llm/strip-comments.codelore.md) · [`src/llm/type-context.ts`](src/llm/type-context.codelore.md)

### [Построение runtime-контекста из литералов](docs/domains/runtime-context.codelore.md#построение-runtime-контекста-из-литералов)

Подсистема владеет полным циклом: извлекает строковые литералы и no-substitution template literals из исходного кода, отфильтровывает технические (импорты, типы, JSDoc, контекстные типы) с помощью функций из ast-helpers, запускает ripgrep для поиска по проекту, фильтрует найденные совпадения через AstHitFilter, разрешает их до содержащей сущности через resolveEnclosing и определяет синтаксическую роль. Возвращает массив RuntimeHit и список литералов без валидных вхождений.

[`src/context/ast-helpers.ts`](src/context/ast-helpers.codelore.md) · [`src/context/ast-hit-filter.ts`](src/context/ast-hit-filter.codelore.md) · [`src/context/enclosing-resolver.ts`](src/context/enclosing-resolver.codelore.md) · [`src/context/literal-extractor.ts`](src/context/literal-extractor.codelore.md) · [`src/context/ripgrep-runner.ts`](src/context/ripgrep-runner.codelore.md) · [`src/context/runtime-context-builder.ts`](src/context/runtime-context-builder.codelore.md)

### [Хранилище индексов и анализа изменений](docs/domains/json-storage.codelore.md#хранилище-индексов-и-анализа-изменений)

[`src/storage/json-storage.ts`](src/storage/json-storage.codelore.md)

### [Визуализация графа файлов](docs/domains/dag-visualization.codelore.md#визуализация-графа-файлов)

[`src/cli/render-graph.ts`](src/cli/render-graph.codelore.md)

### [Общие вспомогательные функции сервиса](docs/domains/service-helpers.codelore.md#общие-вспомогательные-функции-сервиса)

[`src/service/helpers.ts`](src/service/helpers.codelore.md)

### [Фабрика LLM-провайдера](docs/domains/llm-provider-factory.codelore.md#фабрика-llm-провайдера)

[`src/llm/provider.ts`](src/llm/provider.codelore.md)

### [Анализ метрик кода и решения о документировании](docs/domains/code-metrics-analysis.codelore.md#анализ-метрик-кода-и-решения-о-документировании)

Владеет полным конвейером от получения индекса кода до выдачи решений о блоках. computeEntityMetrics делегирует подсчёт операторов, фильтрацию прямых использований и статический поиск побочных эффектов утилитам countStatements, effectiveDirectUsages и hasSideEffects. analyzeClassCohesion измеряет связность классов через пересечение полей, detectPrivateWrappers находит приватные методы, которые являются тонкими обёртками. Затем decideDocumentationRoles, делегируя вычисление роли функции decideEntityRole, получает вес через calculateWeight по логарифмической формуле, назначает роль, а determineBlockInclusion выбирает блоки по метрикам и конфигурации.

[`src/analysis/block-inclusion.ts`](src/analysis/block-inclusion.codelore.md) · [`src/analysis/class-cohesion.ts`](src/analysis/class-cohesion.codelore.md) · [`src/analysis/decision-pass.ts`](src/analysis/decision-pass.codelore.md) · [`src/analysis/entity-metrics.ts`](src/analysis/entity-metrics.codelore.md) · [`src/analysis/wrapper-detector.ts`](src/analysis/wrapper-detector.codelore.md)

### [Валидация и факт-чекинг сгенерированной документации](docs/domains/llm-doc-validation.codelore.md#валидация-и-факт-чекинг-сгенерированной-документации)

Подсистема владеет полным циклом проверки. На этапе структурной валидации она вычисляет множество разрешённых ссылок через `allowedRefsForSection`, строит обратный индекс имён сущностей через `buildEntityNameToIds` и проверяет блоки на соответствие правилам: корректность refs, длину текста, существование упомянутых файловых путей. На этапе факт-чекинга она собирает промпт через `buildVerifyRequest`, отправляет его в LLM и разбирает ответ через `parseVerifyResponse`, отфильтровывая записи, не относящиеся к проверяемым секциям. Оба этапа только выявляют проблемы — подсистема ничего не исправляет.

[`src/llm/doc-validator.ts`](src/llm/doc-validator.codelore.md) · [`src/llm/doc-verifier.ts`](src/llm/doc-verifier.codelore.md)

### [Индексация кода и документации](docs/domains/code-doc-indexing.codelore.md#индексация-кода-и-документации)

Подсистема строит кодовый индекс через buildCodeIndex: обходит файлы, попадающие под sourceGlobs и scope, и для каждой экспортированной сущности фиксирует идентификатор, прямые зависимости и документационные метаданные. Документационный индекс строит buildDocIndex: загружает все состояния через DocStateStorage, преобразует их в секции и заполняет обратные карты fileToSections и entityToSections с детерминированной сортировкой. Инкрементальное обновление выполняет patchDocIndexPaths: удаляет секции для переданных путей, очищает привязки в entityToSections, загружает свежие состояния и добавляет секции заново, сортируя только затронутые списки. Дополнительно buildDomainEntities создаёт синтетические сущности для доменов и проекта на основе CodeIndex и DomainMap, а domainCoverage проверяет покрытие файлов доменами, выявляя uncovered, doubleAssigned и danglingFiles.

[`src/domains/domain-map.ts`](src/domains/domain-map.codelore.md) · [`src/indexer/code-indexer.ts`](src/indexer/code-indexer.codelore.md) · [`src/indexer/domain-entities.ts`](src/indexer/domain-entities.codelore.md) · [`src/indexer/state-indexer.ts`](src/indexer/state-indexer.codelore.md)

### [Конфигурация проекта](docs/domains/project-config.codelore.md#конфигурация-проекта)

[`src/config.ts`](src/config.codelore.md)

### [Обнаружение устаревших блоков документации](docs/domains/stale-blocks-detection.codelore.md#обнаружение-устаревших-блоков-документации)

[`src/service/stale-detection.ts`](src/service/stale-detection.codelore.md)

### [Общие низкоуровневые утилиты](docs/domains/common-utils.codelore.md#общие-низкоуровневые-утилиты)

Хеширует любую строку SHA-256 через node:crypto (sha256). Нормализует обратные слеши в прямые (toPosixPath) и вычисляет относительный путь от корня проекта через resolve (relativeProjectPath) — обе операции только строковые, без доступа к диску или разрешения симлинков. Эвристически определяет, стоит ли исключить путь из индексации (isProbablyExcluded), по простым шаблонам строк — без glob или регулярных выражений. Кодирует (encodeResourceId) и декодирует (decodeResourceId) произвольные идентификаторы в URI-безопасную форму, не добавляя схему или префикс и не проверяя валидность входа.

[`src/domains/assign.ts`](src/domains/assign.codelore.md) · [`src/utils/hash.ts`](src/utils/hash.codelore.md) · [`src/utils/path.ts`](src/utils/path.codelore.md)

### [Отпечатки блоков документации](docs/domains/block-fingerprinting.codelore.md#отпечатки-блоков-документации)

[`src/domains/member-evidence.ts`](src/domains/member-evidence.codelore.md) · [`src/markdown/block-facets.ts`](src/markdown/block-facets.codelore.md)

### [Пайплайн генерации документации файлов](docs/domains/llm-generation-pipeline.codelore.md#пайплайн-генерации-документации-файлов)

Подсистема владеет полным циклом генерации документации: для файлов — загружает контекст, разбивает секции на чанки через planWriterChunks, параллельно обрабатывает каждый чанк (buildFileWriteRequest, parseFileWriteResponse, verifyChunkFacts с циклом ремонта), объединяет результаты, проверяет существующие блоки на соответствие зависимостям через verifyBlocksAgainstDeps и атомарно записывает отладочный снимок через writeGenerationDebug. Для домена — пишет блоки с повторными попытками через generateDomainDoc, верифицирует их по документации членов и исправляет противоречия. Утилита compactChunkCallers уменьшает дублирование тел вызывающих функций, отдавая приоритет вызывающим с runtimeEvidence — это оптимизирует размер промпта перед генерацией.

[`src/llm/domain-pipeline.ts`](src/llm/domain-pipeline.codelore.md) · [`src/llm/file-chunks.ts`](src/llm/file-chunks.codelore.md) · [`src/llm/file-pipeline.ts`](src/llm/file-pipeline.codelore.md) · [`src/llm/file-writer.ts`](src/llm/file-writer.codelore.md) · [`src/llm/generation-debug.ts`](src/llm/generation-debug.codelore.md)

### [Перевод документации](docs/domains/doc-translation.codelore.md#перевод-документации)

Строит запрос к LLM для перевода всех блоков документа, извлекает ответ с повторными попытками при невалидном JSON, выявляет нарушения (отсутствие блока, несовпадение кодовых промежутков, нетранслированный текст) и отправляет ремонтный запрос только для проблемных блоков. Финальная проверка отбрасывает блоки, не прошедшие проверку или отсутствующие после ремонта. Также проверяет, содержит ли сохранённый перевод дефект, требующий перевода заново.

[`src/llm/translator.ts`](src/llm/translator.codelore.md) · [`src/markdown/doc-paths.ts`](src/markdown/doc-paths.codelore.md)

### [Подготовка первичной документации](docs/domains/initial-docs-preparation.codelore.md#подготовка-первичной-документации)

Подсистема нормализует входящий скоуп: приводит пути к POSIX-формату через `normalizePreparePath`, удаляет дубликаты и гарантирует, что `dryRun` — булево значение. Для каждого файла `planFileLayout` сортирует сущности по `startOffset` и назначает заголовки первого уровня. Дальше для каждой сущности `isEntityInPrepareScope` проверяет вхождение в область, а `shouldCreatePage` — роль: страницу получают только сущности с ролью `short_page` или `full_page` (или без роли). Для новых страниц `docStateSectionForPlannedEntity` строит скелетную секцию: упорядочивает разрешённые блоки по каноническому списку, генерирует якорь из заголовка, вычисляет отпечаток каждого блока и собирает `depends`/`usedBy` из прямых зависимостей сущности; `withPreservedBlockBodies` переносит непустые тела блоков из предыдущего состояния. Уже задокументированные сущности подсистема регистрирует как пропущенные через `skippedPreparedDocSection`. В конце `preparedDocsResult` собирает результат: сводку, пропущенные блоки по сущностям и следующее действие — остановиться, выполнить без `--dry-run` или заполнить созданные секции.

[`src/service/domain-docs.ts`](src/service/domain-docs.codelore.md) · [`src/service/file-layout.ts`](src/service/file-layout.codelore.md) · [`src/service/prepare-docs.ts`](src/service/prepare-docs.codelore.md)

### [Применение перезаписей секций](docs/domains/section-rewrite-application.codelore.md#применение-перезаписей-секций)

[`src/service/section-rewrite.ts`](src/service/section-rewrite.codelore.md)

### [Разбор JSON-ответов LLM с повтором запроса](docs/domains/llm-json-response-parsing.codelore.md#разбор-json-ответов-llm-с-повтором-запроса)

Подсистема принимает запрос к LLM, функцию вызова complete и лимит повторов. Она снимает внешний Markdown-фенс, парсит JSON, при неудаче применяет repairKnownLlmEscapes — исправление трёх известных артефактов — и пробует распарсить снова. Если обе попытки сорвались, выбрасывается CodeloreError с кодом INVALID_LLM_RESPONSE. При ошибке парсинга, не являющейся INVALID_LLM_RESPONSE, или при превышении лимита ретраев, выполняется запись отладки, затем ошибка пробрасывается. readOptionalString позволяет безопасно забрать опциональные строки из полученного объекта: нет поля — возвращает undefined, поле есть, но не строка — выбрасывает INVALID_LLM_RESPONSE.

[`src/domains/partition.ts`](src/domains/partition.codelore.md) · [`src/llm/complete-and-parse.ts`](src/llm/complete-and-parse.codelore.md) · [`src/llm/domain-writer.ts`](src/llm/domain-writer.codelore.md) · [`src/llm/json.ts`](src/llm/json.codelore.md)

### [Рендеринг и локализация Markdown-документов](docs/domains/markdown-rendering.codelore.md#рендеринг-и-локализация-markdown-документов)

Подсистема выбирает заголовки блоков в зависимости от языка перевода: для переводных языков берёт локализованные заголовки из config.docs.blockHeadingsByLanguage, иначе канонические из config.docs.blockHeadings. Она формирует заголовки секций с уровнем вложенности, добавляет сигнатуры и навигационные строки, группирует устаревшие блоки в сводный callout и вставляет цитаты о незавершённых переводах. Итоговые Markdown всех секций склеиваются двойным переводом строки, добавляется завершающий \n.

[`src/markdown/callouts.ts`](src/markdown/callouts.codelore.md) · [`src/markdown/linkify.ts`](src/markdown/linkify.codelore.md) · [`src/markdown/locales.ts`](src/markdown/locales.codelore.md) · [`src/markdown/render-doc.ts`](src/markdown/render-doc.codelore.md)

### [Согласование и валидация состояния документации](docs/domains/doc-state-consistency.codelore.md#согласование-и-валидация-состояния-документации)

Подсистема владеет согласованием и валидацией. reconcileDocStateWithCode мутирует DocState: удаляет секции без владельцев и лишние блоки, не входящие в allowedBlocks. Валидация не трогает состояние — она возвращает массив проблем: validateOwnedEntities и validateDependencies находят битые ссылки, detectStaleBlocks сравнивает отпечатки блоков через подсистему отпечатков, validateBlockQuality отсеивает пустые и неотрисованные тела. Каждая проблема — объект DocValidationIssue с уровнем error или warning.

[`src/service/doc-reconcile.ts`](src/service/doc-reconcile.codelore.md) · [`src/service/doc-validation.ts`](src/service/doc-validation.codelore.md)

### [Управление индексом проекта](docs/domains/project-index-manager.codelore.md#управление-индексом-проекта)

[`src/service/index-manager.ts`](src/service/index-manager.codelore.md)

### [Фасад сервиса Codelore](docs/domains/codelore-service-facade.codelore.md#фасад-сервиса-codelore)

[`src/service/codelore-service.ts`](src/service/codelore-service.codelore.md)

### [Хранилище состояния документации](docs/domains/doc-state-storage.codelore.md#хранилище-состояния-документации)

[`src/storage/doc-state-storage.ts`](src/storage/doc-state-storage.codelore.md)

### [MCP-сервер Codelore](docs/domains/mcp-server.codelore.md#mcp-сервер-codelore)

Создаёт настроенный McpServer и регистрирует на нём ресурсы и инструменты документации, делегируя все операции фасаду CodeloreService. Если передан projectContext, дополнительно регистрирует ресурс context://project. Подключает готовый сервер к StdioServerTransport, после чего тот начинает принимать и обрабатывать MCP-запросы.

[`src/server/create-server.ts`](src/server/create-server.codelore.md) · [`src/server/start-stdio-server.ts`](src/server/start-stdio-server.codelore.md)

### [Точка входа CLI](docs/domains/cli-entrypoint.codelore.md#точка-входа-cli)

[`src/cli/run-cli.ts`](src/cli/run-cli.codelore.md)

## Покрытие

Карта охватывает 63 из 72 файлов исходников.

За пределами карты:
- `src/analysis/block-mentions.ts`
- `src/bin/codelore-mcp.ts`
- `src/bin/codelore.ts`
- `src/markdown/block-ids.ts`
- `src/markdown/render-architecture.ts`
- `src/service/architecture-doc.ts`
- `src/service/dep-fingerprints.ts`
- `src/service/stale-detector.ts`
- `src/types.ts`
