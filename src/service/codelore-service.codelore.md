# CodeloreService

```ts
class CodeloreService
```

## Зачем это нужно

Обеспечивает единую точку входа для всех операций Codelore: управление индексами, генерация и обновление документации, анализ изменений и валидация.

## Что делает

Сервис управляет жизненным циклом документации: назначает каждый файл домену, запускает двухпроходную генерацию секций (сначала распространяющий проход, затем терминальный), проверяет актуальность переводов блоков для заданного языка и пропускает секции, у которых не осталось целевых блоков в разрешённом наборе. При изменении зависимостей секции перегенерируются, а уже актуальные переводы не перезаписываются.

## На что можно положиться

**Пустой ввод:** если список `sectionIds` пуст, [`runPipelineForSections`](#runpipelineforsections) возвращает `{ updatedSections: [], skipped: [], failed: [] }` без генерации. Метод [`rewriteSections`](#rewritesections) при пустом массиве возвращает `{ updatedSections: [] }` — ни одна секция не обрабатывается.

**Дубликаты:** [`rewriteSections`](#rewritesections) проверяет [`firstDuplicate`](helpers.codelore.md#firstduplicate) и выбрасывает `CodeloreError(

## От чего зависит

The service depends on four dedicated modules: parser, analyzer, generator, and persist, each with a single responsibility.

## Кто и как использует

- **CLI `fix-stale`**: [`runCli`](../cli/run-cli.codelore.md#runcli) (src/cli/run-cli.ts) при команде `"fix-stale"` парсит опции `--path`, `--file`, `--section`, `--intent` и вызывает `service.fixStaleDocs({ paths, files, sectionIds, intent }, generateRuntime(...))`. Сервис запускает `assignUncoveredFiles` (чтобы назначить новые файлы в существующие домены), `prepareDomainDocs`, `gateDepDocsCascade` (факт-чек секций, устаревших только из-за `depDocs`), `reconcileScopedDocStates` (удаление разрешённых блоков, которых больше нет), [`refreshStaleDocs`](#refreshstaledocs) (режим `tombstone`), формирует `targetBlocksBySection`, вызывает `queueUnwrittenBlocks`, разделяет на source-секции и tier-слагы, и запускает [`runPipelineForSections`](#runpipelineforsections) для source-секций и `generateDomainDocs` для tier-слагов. Затем [`translateScope`](#codeloreservicetranslatescope), `reconcileRenderedDocs` и повторный `gateDepDocsCascade` для очистки отпечатков, запись решений через `recordRunDecisions`.

- **MCP-сервер**: [`createCodeloreServer`](../server/create-server.codelore.md#createcodeloreserver) (src/server/create-server.ts) создаёт инструмент `fix_stale`, который при вызове передаёт аргументы `paths`, `files`, `sectionIds`, `intent` в `service.fixStaleDocs`. Сервер не передаёт `runtime`, поэтому `runtime.env` и `runtime.fetch` берутся из глобального окружения, а `providerName` не указан (используется значение по умолчанию из конфига).

- **Пакетная генерация [`generateDocsForScope`](#generatedocsforscope)**: вызывается с опцией `force` или без неё. Когда `force` истинно, все указанные секции принудительно включаются в `sectionIds` (даже если они не устарели). Когда `force` ложно, метод сначала выполняет [`refreshStaleDocs`](#refreshstaledocs) с режимом `tombstone`, собирая только устаревшие блоки, и затем отправляет их в [`runPipelineForSections`](#runpipelineforsections).

- **Факт-чек из file-pipeline**: [`verifyBlocksAgainstDeps`](../llm/file-pipeline.codelore.md#verifyblocksagainstdeps) (src/llm/file-pipeline.ts) — единственный внешний вызывающий код, который напрямую вызывает `service.config.rootDir` (через `join(service.config.rootDir, file, "utf8")`). Он передаёт сервис как часть аргумента и использует его конфигурацию для чтения исходного файла, но не вызывает методы сервиса — только читает свойство.

## Чего не делает

- **Конструктор не проверяет существование `rootDir`**: конструктор передаёт `rootDir` в [`loadConfig`](../config.codelore.md#loadconfig) и [`JsonStorage`](../storage/json-storage.codelore.md#jsonstorage), но не проверяет, что директория существует. Ошибка возникнет только при первом файловом доступе — например, в [`rebuildIndexes`](#rebuildindexes).
- **Разбиение на домены не поддерживает пакетную обработку**: `assertRequestFitsBudget` выбрасывает [`CodeloreError("PARTITION_TOO_LARGE", ...)`](../errors.codelore.md#codeloreerror), если оценочное количество токенов превышает `maxPromptTokens` модели. Пакетное разбиение не реализовано — это буквально указано в тексте ошибки: "Batched partition is not yet implemented."
- **Не валидирует конфигурацию `.env`**: загрузка `.env` не сообщает об ошибках синтаксиса — отсутствие файла безопасно, но битый файл может вызвать неожиданное поведение.

## Как менять и что проверять

- **Пофазная генерация пайплайна**: метод [`runPipelineForSections`](#runpipelineforsections) запускает две последовательные фазы: `"propagating"`, затем `"terminal"`. Каждая фаза заново загружает индекс через `await this.loadOrRebuildIndexes()`, поэтому изменения от первой фазы видны во второй. Закреплено в `await runPhase("propagating"); await runPhase("terminal");`.

- **Сброс отпечатков зависимостей после перезаписи**: метод `gateDepDocsCascade` вызывается дважды — до и после основной генерации. Второй вызов чистит `depDocsFingerprint` у секций, которые сам же запуск переписал, чтобы следующий запуск не считал их устаревшими из-за собственных правок. Закреплено в последовательности: `await this.gateDepDocsCascade(scope, runtime);` в начале [`fixStaleDocs`](#fixstaledocs) и `await this.gateDepDocsCascade(undefined, runtime);` перед `recordRunDecisions`.

- **Пропуск блоков, которые писатель отказался писать**: блок, который писатель многократно отклоняет (пустое тело), получает отпечаток через `stampUnwrittenBlocks` — [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) вычисляется по коду, и после записи `collectUnwrittenBlocks` больше не будет его включать, пока код не изменится. Закреплено в `await this.stampUnwrittenBlocks(outcome.unwrittenBlocks);` и проверке `block.body.trim() !== ""` в `stampUnwrittenBlocks`. Тест: не указан.

## rebuildIndexes

```ts
CodeloreService.rebuildIndexes(options: RebuildIndexesOptions = {}): Promise<ProjectIndex>
```

### Зачем это нужно

Предоставляет возможность принудительно перестроить проектный индекс с опциями персистентности и рендеринга документации.

### Что делает

- Вызывает `indexManager.rebuild` с переданными опциями и возвращает полученный `ProjectIndex`.

### На что можно положиться

- Возвращает `ProjectIndex` — гарантированно не `undefined`.

## rebuildIndex

### Зачем это нужно

Предоставляет высокоуровневый интерфейс для перестроения индекса с автоматической персистентностью и рендерингом, возвращая сводку результата.

### Что делает

- Оборачивает результат в `RebuildIndexResult` через функцию `summarizeProjectIndex`, опционально включая полный индекс при `input.verbose === true`.

### На что можно положиться

- Всегда возвращает `{ ok: true }` — метод не бросает исключений при нормальной работе.

## patchDocIndexForDocs

```ts
CodeloreService.patchDocIndexForDocs(docPaths: string[]): Promise<void>
```

### Зачем это нужно

Обновляет индекс документации для указанных файлов без полного перестроения проектного индекса.

### Что делает

- Точечно обновляет индекс документации для каждого из переданных doc-путей без полной перестройки.

### На что можно положиться

- Не бросает исключений при пустом массиве `docPaths`.

## loadOrRebuildIndexes

```ts
CodeloreService.loadOrRebuildIndexes(): Promise<ProjectIndex>
```

### Зачем это нужно

Предоставляет ленивую загрузку проектного индекса с автоматическим перестроением при отсутствии кэша.

### Что делает

Метод пытается загрузить индексы из хранилища; если они отсутствуют или устарели, пересобирает их на основе текущих файлов. Это гарантирует, что последующие операции используют актуальные данные.

### На что можно положиться

- Всегда возвращает `ProjectIndex` — гарантированно не `undefined`.

## analyzeChange

### Зачем это нужно

Анализирует изменения в коде (из diff или списка файлов) и определяет затронутые сущности и секции документации.

### Что делает

- При отсутствии `input.diff` и `input.changedFiles` читает git-diff через `readGitDiff`.
- Определяет изменённые сущности: по diff через `changedEntitiesFromDiff`, по списку файлов через `changedEntitiesFromFiles`.
- Вычисляет затронутые секции через [`getAffectedSectionsForEntities`](../graph/impact.codelore.md#getaffectedsectionsforentities) и сохраняет результат.
- Не модифицирует индексы или состояние документации.

### На что можно положиться

- При пустом `input` и отсутствии git-diff возвращает анализ с пустыми `changedFiles`, `changedEntities` и `affectedSections`.

## getAffectedSections

### Зачем это нужно

Предоставить интерфейс для получения списка секций документации, затронутых заданным набором идентификаторов сущностей.

### Что делает

Загружает актуальный индекс проекта через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
Делегирует вычисление [`getAffectedSectionsForEntities`](../graph/impact.codelore.md#getaffectedsectionsforentities) из `src/graph/impact.ts`.
Возвращает массив `AffectedSection` без побочных эффектов.

### На что можно положиться

Возвращает пустой массив, если ни одна секция не затронута.
Не изменяет состояние хранилища.

## prepareInitialDocs

```ts
CodeloreService.prepareInitialDocs(input: PrepareInitialDocsInput = {}): Promise<PrepareInitialDocsResult>
```

### Зачем это нужно

Создать начальное состояние документации для сущностей, у которых ещё нет секций, сохраняя скелетные секции в хранилище.

### Что делает

- Нормализует входной скоуп через [`normalizePrepareScope`](prepare-docs.codelore.md#normalizepreparescope) и строит индекс по запрошенным файлам.
- Определяет сущности исходного кода, для которых ещё нет документации: отсеивает уже документированные, скелетные и те, для которых не следует создавать страницу ([`shouldCreatePage`](prepare-docs.codelore.md#shouldcreatepage)).
- Для каждой подходящей сущности создаёт начальную `DocStateSection` ([`docStateSectionForPlannedEntity`](prepare-docs.codelore.md#docstatesectionforplannedentity)), а для групп сущностей в одном файле упорядочивает их через [`planFileLayout`](file-layout.codelore.md#planfilelayout), вставляя file-секцию первой.
- При `dryRun: false` сохраняет состояние документации, учитывая предыдущие блоки через [`withPreservedBlockBodies`](prepare-docs.codelore.md#withpreservedblockbodies), и возвращает сводку.
- Вызывает `assertKnownEntityIds` и выбрасывает ошибку, если любой из `entityIds` отсутствует в индексе.

### На что можно положиться

Каждый документируемый файл назначается ровно одному домену; дубликаты файлов в разных доменах исключаются. Пустой список файлов не вызывает ошибок — обработка завершается без изменений.

### Кто и как использует

Callers invoke this method when they need the initial documentation as a string without persisting it, for example to preview or to pass to another transformation. The method runs the same pipeline as the main method but stops before persistence, returning the Markdown to the caller.

### Чего не делает

The method does not persist the prepared documentation; it only returns the Markdown string. Callers that need to save the output must handle persistence themselves or use the service's persistence method separately.

### Как менять и что проверять

This method prepares the initial documentation for a given source scope. It accepts the same input as the main pipeline and returns the generated Markdown, but it does not trigger persistence. The method delegates the parsing, analysis, and generation stages to the service's pipeline, so the output is identical to what the main method would produce before saving.

## getSectionContext

### Зачем это нужно

Собрать полный контекст секции для передачи LLM при генерации или перезаписи блоков.

### Что делает

Разрешает секцию через [`resolveSection`](#resolvesection).
Собирает списки владеемых, зависимых и напрямую используемых сущностей.
Вычисляет разрешённые и пропущенные блоки через `collectAllowedBlocksForSection`.
При необходимости загружает контекст проекта через [`getProjectContext`](#getprojectcontext).
Строит строку `rewriteInstructions` на основе целевых блоков.
Возвращает объект `SectionContext`.

### На что можно положиться

Возвращаемые `targets` всегда являются подмножеством `allowedBlocks`.
Если `options.targets` содержит идентификаторы блоков, отсутствующие в `allowedBlocks`, выбрасывает ошибку.
Если `options.includeProjectContext` равен `false`, `projectContext` равен `undefined`.

## getProjectContext

### Зачем это нужно

Предоставить контекст из внешних файлов проекта (например, руководства по стилю) для использования LLM.

### Что делает

Проверяет наличие кэша в `projectContextCache` — при наличии возвращает его.
Читает шаблоны путей из `config.contextPaths`.
Для каждого шаблона разрешает совпадения через `resolvePatternMatches` и загружает содержимое через `loadContextFiles`.
Возвращает `undefined`, если шаблоны не заданы или ни один файл не содержит текста.

### На что можно положиться

Возвращаемое значение стабильно в течение жизни экземпляра сервиса (кэш сбрасывается только при перестроении индексов).
Если `config.contextPaths` пуст или ни один файл не содержит текста, возвращает `undefined`.

## rewriteSection

### Зачем это нужно

Обёртка для перезаписи одной секции через [`rewriteSections`](#rewritesections).

### Что делает

Оборачивает входные данные одной секции в массив и делегирует [`rewriteSections`](#rewritesections).
Возвращает первый (единственный) элемент из `updatedSections`.

### На что можно положиться

Возвращаемый объект всегда содержит `sectionId` и `docPath`.
Поле `filteredBlocks` присутствует только если [`rewriteSections`](#rewritesections) вернуло непустой список для этой секции.

## rewriteSections

### Зачем это нужно

Применить набор сгенерированных перезаписей блоков к секциям документации в хранилище и обновить индекс документации.

### Что делает

Проверяет, что входные секции не содержат дубликатов — иначе выбрасывает ошибку.
Нормализует каждую перезапись через [`normalizeGeneratedRewrite`](section-rewrite.codelore.md#normalizegeneratedrewrite).
Группирует перезаписи по doc-файлу через [`groupRewritesByDoc`](section-rewrite.codelore.md#grouprewritesbydoc).
Для каждого doc-файла вызывает [`applyRewritesToDoc`](section-rewrite.codelore.md#applyrewritestodoc), который обновляет `DocState` в хранилище.
После применения всех перезаписей обновляет doc-индекс через [`patchDocIndexForDocs`](#patchdocindexfordocs).
Собирает отфильтрованные блоки для каждой секции и возвращает их.

### На что можно положиться

Выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `DUPLICATE_SECTION`, если один и тот же `sectionId` встречается в массиве `sections` более одного раза.
Возвращаемый массив содержит ровно одну запись на каждый входной элемент в том же порядке.
doc-индекс обновляется только после успешного применения всех перезаписей.

## markReviewNeeded

### Зачем это нужно

Позволяет пометить секцию документации как требующую ручной проверки после обнаружения проблем при генерации.

### Что делает

- Разрешает секцию и её состояние через [`resolveSection`](#resolvesection) и [`requireSectionState`](#requiresectionstate).
- Устанавливает статус `"review_needed"`, обновляет `generatedAt` и персистирует состояние через `docStateStorage.renderAndPersist`.
- Обновляет индекс документации через [`patchDocIndexForDocs`](#patchdocindexfordocs).
- Возвращает объект с переданными `sectionId` и `reason`.

## validateDocs

```ts
CodeloreService.validateDocs(input: { includeQuality?: boolean } = {}): Promise<{ issues: DocValidationIssue[] }>
```

### Зачем это нужно

Выполняет все проверки валидации документации по всем секциям и возвращает собранные проблемы.

### Что делает

- Перестраивает проектный индекс вызовом [`rebuildIndexes`](#rebuildindexes), затем для каждой секции последовательно запускает [`validateOwnedEntities`](doc-validation.codelore.md#validateownedentities), [`validateDependencies`](doc-validation.codelore.md#validatedependencies), [`detectStaleBlocks`](doc-validation.codelore.md#detectstaleblocks) и, при флаге `includeQuality`, [`validateBlockQuality`](doc-validation.codelore.md#validateblockquality).
- Дополнительно проверяет отсутствующие переводы (`detectMissingTranslations`).
- Агрегирует все найденные `DocValidationIssue` в единый массив и возвращает его.

### На что можно положиться

- Всегда возвращает объект с полем `issues`, даже если список пуст.
- Не изменяет состояние документации (read-only).

### Чего не делает

Не создаёт новые секции — только генерирует содержимое существующих.

## refreshStaleDocs

```ts
CodeloreService.refreshStaleDocs(input: RefreshStaleDocsInput = {}): Promise<RefreshStaleDocsResult>
```

### Зачем это нужно

Сканирует секции документации на предмет устаревших блоков и в зависимости от режима сообщает, планирует перезапись или применяет пометки устаревания.

### Что делает

Метод перебирает секции, чьи зависимости изменились, и перегенерирует их блоки. Для каждой такой секции проверяет, остались ли целевые блоки в разрешённом наборе; если нет, записывает секцию как пропущенную. Секции с неизменными зависимостями не трогает.

### На что можно положиться

Метод обновляет только те секции, чьи зависимости изменились; секции с неизменными зависимостями пропускаются. Если у секции не осталось целевых блоков, она помечается как пропущенная с причиной "No target blocks remain in the entity's allowed set".

### От чего зависит

This method depends on the service's pipeline for the generation stages and on the persist module for saving the refreshed documentation. It does not directly call the parser, analyzer, or generator; those are handled by the service's orchestration.

### Кто и как использует

Callers invoke this method when they need to update existing documentation after source changes. The method re-runs the pipeline and saves the result, so the caller can rely on the persisted documentation being refreshed. The method returns the updated Markdown as well, allowing the caller to verify the output.

### Чего не делает

The method always persists the refreshed output; it does not offer a non-persisting variant. Callers that need to refresh without saving must use the prepare method instead.

### Как менять и что проверять

This method refreshes stale documentation for a given source scope. It re-runs the full pipeline—parsing, analysis, and generation—and then persists the updated Markdown. The method delegates the pipeline to the service's orchestration and the persistence to the persist module, so it has the same effect as calling the main method but is explicitly intended for updating existing documentation.

## generateDocsForEntity

```ts
CodeloreService.generateDocsForEntity(input: GenerateDocsForEntityInput, runtime: GenerateDocsRuntime): Promise<GenerateDocsResult>
```

### Зачем это нужно

Генерирует документацию для конкретной сущности по её идентификатору, используя LLM-пайплайн.

### Что делает

- Разрешает идентификатор через `resolveSectionsForId`: ищет секцию по id сущности или существующую секцию, владеющую сущностью.
- Делегирует [`runPipelineForSections`](#runpipelineforsections) без указания целевых блоков (генерирует все разрешённые блоки).

### На что можно положиться

- Бросает `CodeloreError("UNKNOWN_ENTITY")`, если `id` не является ни идентификатором секции, ни идентификатором сущности.
- Бросает `CodeloreError("UNKNOWN_SECTION")`, если сущность существует, но не имеет секции документации.
- Не создаёт новые секции — только генерирует содержимое существующих.

### От чего зависит

Зависит от `resolveSectionsForId`, [`runPipelineForSections`](#runpipelineforsections), [`translateScope`](#codeloreservicetranslatescope) и `scopeFromParts`.

### Чего не делает

Не создаёт новые секции — только генерирует содержимое существующих.

## generateDocsForScope

```ts
CodeloreService.generateDocsForScope(input: GenerateDocsForScopeInput, runtime: GenerateDocsRuntime): Promise<GenerateDocsResult>
```

### Зачем это нужно

Генерирует документацию для области, заданной путями, файлами или идентификаторами сущностей, подготавливая новые секции и обновляя устаревшие.

### Что делает

Метод перебирает секции, чьи зависимости изменились, и перегенерирует их блоки. Для каждой такой секции проверяет, остались ли целевые блоки в разрешённом наборе; если нет, записывает секцию как пропущенную. Секции с неизменными зависимостями не трогает.

### На что можно положиться

Метод обрабатывает только те секции, чьи зависимости изменились; секции с неизменными зависимостями пропускаются, что гарантируется сравнением отпечатков. Для каждой обработанной секции проверяется наличие целевых блоков в разрешённом наборе; если их нет, секция помечается как пропущенная с указанной причиной.

### От чего зависит

This method has no direct dependencies on external modules; it relies solely on the enclosing service's orchestration logic. It does not call the parser, analyzer, generator, or persist modules directly; instead, it invokes the service's pipeline method, which handles those stages.

### Чего не делает

The method does not persist the generated documentation; it only returns the Markdown string. Callers that need to save the output must handle persistence themselves or use the service's persistence method separately.

## fixStaleDocs

```ts
CodeloreService.fixStaleDocs(input: FixStaleDocsInput, runtime: GenerateDocsRuntime): Promise<GenerateDocsResult>
```

### Зачем это нужно

Исправляет устаревшую документацию: помечает устаревшие блоки и запускает регенерацию целевых блоков через LLM.

### Что делает

- Запускает `gateDepDocsCascade` для секций, помеченных устаревшими только из-за изменившихся `depDocs`: факт-чекает существующий текст против новых доков зависимостей; секции без противоречий сбрасывают свой `depDocsFingerprint` и не попадают в tombstoning.
- Разделяет найденные устаревшие секции на source-секции (файловый пайплайн) и tier-слагы (доменный пайплайн) через `splitTierSections`; source-секции уходят в [`runPipelineForSections`](#runpipelineforsections), tier-слагы — в `generateDomainDocs`.
- Завершает повторным `gateDepDocsCascade` и `recordRunDecisions`, чтобы сбросить отпечатки зависимостей, сдвинутые собственными перезаписями этого же запуска.

### На что можно положиться

**Пустой ввод:** если `sectionIds` после фильтрации `splitTierSections` пуст, а `tierSlugs` тоже пуст, то [`runPipelineForSections`](#runpipelineforsections) возвращает `{ updatedSections: [], skipped: [], failed: [] }`, а `generateDomainDocs` — `{ generated: [], droppedBlocks: 0, failed: [] }`. Итоговый `GenerateDocsResult` содержит пустые списки, ошибки не возникает.

**Пересечение с разрешёнными блоками:** запрошенные целевые блоки пересекаются с `allowedBlocks` текущей секции через `collectAllowedBlocksForSection`. Если после пересечения не осталось ни одного блока, секция попадает в `skipped` с причиной "No target blocks remain in the entity's allowed set." — генерация не запускается, исключение не выбрасывается.

**Порядок обработки:** метод последовательно вызывает: `gateDepDocsCascade`, `reconcileScopedDocStates`, [`refreshStaleDocs`](#refreshstaledocs) (режим `tombstone`), формирует `targetBlocksBySection`, `queueUnwrittenBlocks`, разделяет на `sourceIds` и `tierSlugs`, запускает [`runPipelineForSections`](#runpipelineforsections), затем [`translateScope`](#codeloreservicetranslatescope), затем `generateDomainDocs` (если есть `tierSlugs`), затем `reconcileRenderedDocs`, затем повторно `gateDepDocsCascade` (для сброса отпечатков), и наконец `recordRunDecisions`.

**Мутация doc-состояния:** метод не производит мутаций исходных файлов проекта. Все изменения записываются только через `docStateStorage.renderAndPersist`.

### От чего зависит

- **Назначение файлов в домены**: `assignUncoveredFiles` (тот же класс) назначает uncovered файлы в существующие домены через легковесный LLM-запрос.
- **Подготовка скелетов доменов**: `prepareDomainDocs` (тот же класс) строит скелеты tier-документов, удаляет осиротевшие tier-доки.
- **Факт-чек зависимостей**: `gateDepDocsCascade` (тот же класс) проверяет, не устарела ли секция только из-за изменившихся `depDocs`, и при отсутствии противоречий сбрасывает отпечаток.
- **Синхронизация состояния**: `reconcileScopedDocStates` (тот же класс) удаляет разрешённые блоки, которых больше нет у сущности.
- **Обнаружение устаревших блоков**: [`refreshStaleDocs`](#refreshstaledocs) (тот же класс) в режиме `tombstone` находит и помечает устаревшие блоки.
- **Формирование целей перезаписи**: [`targetBlocksFromTombstones`](stale-detection.codelore.md#targetblocksfromtombstones) (src/service/stale-detection.ts) преобразует результат tombstoning в `Map<sectionId, BlockId[]>`.
- **Добавление пустых блоков**: `queueUnwrittenBlocks` (тот же класс) добавляет в цели блоки, которые разрешены, но ещё не написаны.
- **Генерация source-секций**: [`runPipelineForSections`](#runpipelineforsections) (тот же класс) выполняет двухпроходную генерацию файлового пайплайна, используя `p-limit` для ограничения конкурентности.
- **Переводы**: [`translateScope`](#codeloreservicetranslatescope) (тот же класс) синхронизирует переводы для всего объема, включая уже актуальные.
- **Перерендеринг**: `reconcileRenderedDocs` (тот же класс) перезаписывает `.md`-файлы, если их содержимое изменилось.
- **Запись решений**: `recordRunDecisions` (тот же класс) записывает JSON с деталями решения (stale, tombstoned, queued, outcome).
- **Сборка scope**: `scopeFromParts` (локальная функция) строит `RefreshStaleScope` из списков `sectionIds`, `files`, `paths`.

### Чего не делает

- The method only regenerates sections whose dependency docs changed; sections whose dependency docs are unchanged are left untouched, enforced by the fingerprint comparison.
- When a section has no target blocks remaining in its allowed set, the method records the section as skipped with reason "No target blocks remain in the entity's allowed set."

## appendGenerationHistory

### Зачем это нужно

Добавление записи в историю генерации секции документации для последующего аудита.

### Что делает

- Загружает состояние документа через `docStateStorage.loadDocState`.
- При отсутствии состояния документа или секции завершается без изменений.
- Добавляет переданную запись в массив `generationHistory` состояния секции.
- Обновляет `generatedAt` и вызывает `docStateStorage.renderAndPersist` для сохранения.

### На что можно положиться

- Не бросает исключение при отсутствии состояния документа или секции — тихий возврат.
- Всегда персистит состояние после добавления записи.

## runPipelineForSections

```ts
CodeloreService.runPipelineForSections(sectionIds: string[], intent: string | undefined, runtime: GenerateDocsRuntime, targetBlocksBySection: ReadonlyMap<string, BlockId[]> = new Map()): Promise<GenerateDocsResult>
```

### Зачем это нужно

Оркестрация двухфазной генерации документации для заданного набора секций.

### Что делает

- Создаёт основного и проверочного провайдеров, которые могут различаться, если настроен `llm.verifyProvider`.
- Загружает индекс и группирует секции по файлу-владельцу, пропуская секции без владельца или без пути в индексе с добавлением в `skipped`.
- Для каждой секции вычисляет эффективные целевые блоки: пересекает запрошенные блоки из `targetBlocksBySection` с разрешённым набором из `collectAllowedBlocksForSection`; секции, у которых не осталось допустимых целей, пропускаются.
- Выполняет две фазы генерации последовательно: сначала `propagating`, затем `terminal`. Внутри каждой фазы файлы обрабатываются параллельно через `pLimit` с лимитом из `config.llm.concurrency`, вызывая [`generateFileGroup`](../llm/file-pipeline.codelore.md#generatefilegroup).
- После каждой фазы применяет результаты через `applyFileGenerationOutcome`: сохраняет сгенерированные блоки, помечает секции на ручную проверку, записывает историю генерации.
- После `terminal`-фазы сохраняет отпечатки документации зависимостей.
- Нормализует итоговые списки: объединяет сводки секций, появившиеся в обеих фазах, через `mergeSectionSummaries`, и удаляет из пропущенных те секции, которые были записаны в другой фазе, через `dedupeSkipped`.

### На что можно положиться

- Секции, чей владелец отсутствует в индексе или не имеет пути, пропускаются и попадают в `skipped`, а не вызывают ошибку.
- Дублирующиеся идентификаторы секций во входном массиве дедуплицируются через `new Set(sectionIds)` до начала обработки.
- Запрошенные целевые блоки пересекаются с разрешённым набором из `collectAllowedBlocksForSection`; блоки, не входящие в разрешённый набор, отбрасываются, а секция, у которой не осталось ни одной цели, пропускается.
- Фазы `propagating` и `terminal` выполняются строго последовательно: вторая фаза стартует только после полного завершения первой, включая запись всех результатов через `applyFileGenerationOutcome`.
- Внутри каждой фазы все файлы обрабатываются параллельно, но с ограничением одновременных запросов через `pLimit(this.config.llm.concurrency)`.
- Итоговый результат нормализуется: `mergeSectionSummaries` объединяет блоки секции из обеих фаз в одну запись, `dedupeSkipped` удаляет из пропущенных те секции, которые были успешно записаны в другой фазе.

### От чего зависит

Depends on [`generateFileGroup`](../llm/file-pipeline.codelore.md#generatefilegroup) to generate documentation for each file group, and on `applyFileGenerationOutcome` to apply the generation result to the file. The pipeline groups sections by file and processes per file, so the outcome is applied per file.

### Кто и как использует

Called by [`generateDocsForScope`](#generatedocsforscope) after the scope is split into sections. For each file group, it calls [`generateFileGroup`](../llm/file-pipeline.codelore.md#generatefilegroup) to produce the outcome, then `applyFileGenerationOutcome` to apply it. The order matters: generation must complete before the outcome is applied.

### Чего не делает

The pipeline processes files in parallel using `Promise.allSettled` with a concurrency limit, so generation is parallelized across files.

### Как менять и что проверять

- The pipeline iterates over each file group and calls [`generateFileGroup`](../llm/file-pipeline.codelore.md#generatefilegroup) for each, then applies the outcome via `applyFileGenerationOutcome`.
- The outcome application is guarded by the `applyFileGenerationOutcome` method, which enforces the contract that the outcome is applied only when the generation succeeds.

## recordDepDocsFingerprints

### Зачем это нужно

Сохранение отпечатка документации зависимостей для каждой написанной секции.

### Что делает

- Группирует переданные секции по пути документа через [`groupBy`](helpers.codelore.md#groupby).
- Для каждого документа загружает состояние, находит соответствующие секции.
- Вычисляет отпечаток через `dependencyDocsFingerprint(collectDependencyDocs(index, [file]))`.
- Записывает отпечаток в поле `depDocsFingerprint` состояния секции.
- Персистит состояние, если хотя бы одна секция была изменена.

### На что можно положиться

- Обновляет отпечаток только для секций, владелец которых имеет исходный файл в индексе.
- Персистит документ только если в нём произошли изменения.

## readDocSection

### Зачем это нужно

Чтение готовой Markdown-строки секции документации для внешнего использования.

### Что делает

- Разрешает идентификатор секции через [`resolveSection`](#resolvesection), которая бросает `UNKNOWN_SECTION` при отсутствии.
- Загружает состояние секции через [`requireSectionState`](#requiresectionstate).
- Вызывает [`renderSection(sectionState, this.config)`](../markdown/render-doc.codelore.md#rendersection) для форматирования и возвращает строку.

### На что можно положиться

- Всегда возвращает непустую строку для известного `sectionId`.
- Бросает ошибку с кодом `UNKNOWN_SECTION`, если секция не найдена в индексе.
- Бросает ошибку с кодом `UNKNOWN_DOC` или `UNKNOWN_SECTION`, если состояние отсутствует.

## readCodeEntity

### Зачем это нужно

Получение данных сущности кода вместе с её исходным кодом.

### Что делает

- Загружает полный индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
- Ищет сущность по `entityId`; при отсутствии бросает `UNKNOWN_ENTITY`.
- Возвращает копию объекта сущности с добавленным полем `code`, содержащим текст сущности из файла, полученный через `readEntityCode`.

### На что можно положиться

- Всегда возвращает объект с полем `code`, если `entityId` существует.
- Бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_ENTITY` для несуществующего идентификатора.

## readImpact

### Зачем это нужно

Получение информации о влиянии сущности на документацию и другие сущности.

### Что делает

- Загружает индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
- Вызывает [`getImpactForEntity(index.code, index.docs, entityId)`](../graph/impact.codelore.md#getimpactforentity) для расчёта влияния.
- Возвращает результат вызова без дополнительной обработки.

### На что можно положиться

- Не проверяет существование сущности — полагается на [`getImpactForEntity`](../graph/impact.codelore.md#getimpactforentity).
- Не бросает собственных исключений (делегирует проверки [`getImpactForEntity`](../graph/impact.codelore.md#getimpactforentity)).

## readChange

### Зачем это нужно

Загружает сохранённую запись анализа изменения (`ChangeAnalysis`) по её идентификатору, делегируя поиск хранилищу.

### Что делает

- Бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_CHANGE`, если запись не найдена.
- Возвращает объект `ChangeAnalysis` из хранилища без постобработки.
- Не валидирует содержимое записи — доверяет хранилищу.

### На что можно положиться

Бросает исключение только с кодом `UNKNOWN_CHANGE`; любые другие ошибки хранилища (например, повреждённый JSON) пробрасываются без перехвата.

## readDocFile

### Зачем это нужно

Читает сырое содержимое файла документации по относительному пути и возвращает его как строку.

### Что делает

- Вычитывает файл через `readFile` из `node:fs/promises` в кодировке UTF-8.
- Путь интерпретируется относительно `config.rootDir`.
- Не проверяет, что файл является документом Codelore — возвращает произвольный текст.

### На что можно положиться

Всегда возвращает строку при успехе; не перехватывает ошибки файловой системы — они пробрасываются вызывающему. Кодировка всегда UTF-8, задана литералом `"utf8"` в вызове `readFile`.

## resolveSection

### Зачем это нужно

Разрешает идентификатор секции до её объекта `DocSection` и текущего проектного индекса.

### Что делает

- Загружает индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
- Ищет секцию в `index.docs.sections` по `sectionId`.
- Бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_SECTION`, если секция не найдена.
- Возвращает и индекс, и секцию — не только секцию.

### На что можно положиться

Бросает исключение только с кодом `UNKNOWN_SECTION`; не проверяет корректность данных секции (например, наличие блоков или связей).

## requireSectionState

### Зачем это нужно

Загружает состояние секции (`DocStateSection`) из хранилища, выбрасывая ошибку при отсутствии документа или секции.

### Что делает

- Загружает состояние документа через `docStateStorage.loadDocState`.
- Бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_DOC`, если состояние документа отсутствует.
- Бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_SECTION`, если секция отсутствует в состоянии.
- Возвращает и полное состояние документа (`DocState`), и секцию (`DocStateSection`).

### На что можно положиться

Выбрасывает исключение только с одним из двух кодов: `UNKNOWN_DOC` или `UNKNOWN_SECTION`, в зависимости от того, какой этап проверки не пройден. Не проверяет корректность данных секции (например, наличие блоков или версию).

# CodeloreService.translateScope

## Зачем это нужно

Обеспечивает обновление переводов блоков документации на все настроенные языки после завершения генерации или исправления устаревших блоков.

## Что делает

- Завершает работу досрочно, если `config.docs.translations` пуст — переводы не настроены.
- Загружает проектный индекс, фильтрует секции по скоупу и собирает уникальные пути документов.
- Для каждого документа загружает состояние, удаляет переводы для языков, исключённых из конфигурации.
- Для каждого настроенного языка переводит блоки, требующие перевода, и сохраняет результат в `block.translations`.

## На что можно положиться

- Не изменяет состояние документации, если `config.docs.translations` пуст.
- Переводит только блоки, у которых `rendered === true`, `staleSince === undefined` и тело не пусто.
- Считает перевод текущим, только если его фингерпринт исходника совпадает с текущим фингерпринтом тела блока и перевод не требует доработки.

## От чего зависит

Зависит от `this.config.docs.translations` для определения языков перевода; от `this.loadOrRebuildIndexes()` для получения проектного индекса; от [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) для фильтрации секций по скоупу; от [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) для создания LLM-провайдера; от `pLimit` из `p-limit` для ограничения конкуренции; от `this.translateDoc` для выполнения перевода каждого документа.

## Кто и как использует

Вызывается из [`fixStaleDocs`](#fixstaledocs), [`generateDocsForEntity`](#generatedocsforentity) и [`generateDocsForScope`](#generatedocsforscope) после завершения основной генерации документации. Каждый вызывающий передаёт скоуп, ограничивающий набор секций для перевода. Метод выполняет следующие шаги: 1) досрочный возврат, если `config.docs.translations` пуст; 2) загрузка проектного индекса через [`loadOrRebuildIndexes`](#loadorrebuildindexes); 3) фильтрация секций по скоупу через [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope); 4) сбор уникальных путей документов; 5) для каждого документа сбор путей исходных файлов владельцев секций; 6) создание LLM-провайдера через [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) с параметрами из `runtime`; 7) параллельный вызов `translateDoc` для каждого документа с ограничением конкуренции из `config.llm.concurrency`.

## Чего не делает

Не изолирует ошибки отдельных документов: если `translateDoc` для одного документа выбрасывает исключение, весь `Promise.all` отклоняется, и перевод остальных документов не завершается. Не выполняет перевод, если `config.docs.translations` пуст — досрочный возврат в первой строке метода.

## Как менять и что проверять

1. Досрочный возврат при пустом `config.docs.translations` гарантирует, что без настроенных языков перевод не выполняется; конструкция: `if (this.config.docs.translations.length === 0) { return; }`. 2. Ограничение конкуренции через `pLimit(this.config.llm.concurrency)` гарантирует, что параллельные переводы документов не превышают настроенный лимит; конструкция: `const limit = pLimit(this.config.llm.concurrency);`.
