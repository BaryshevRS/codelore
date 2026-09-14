# codelore-service.ts

## Зачем это нужно

The file provides two private methods that both traverse an entity's direct dependencies to produce domain-write data: one yields dependency summaries with optional purpose, the other yields member summaries, each with distinct source resolution rules.

## Что делает

- Собирает в один слой оркестрацию всей документационной системы: класс [`CodeloreService`](#codeloreservice) связывает конфиг, индексы кода и документации, состояние документов на диске и LLM-провайдеров, а хелперы файла (`splitTierSections`, `collectAllowedBlocksForSection`, `resolveTargets`, `scopeFromParts`, `sourceFilePathOf`) задают общие правила, на которых держатся методы класса.
- Разводит генерацию по двум конвейерам с общей границей `splitTierSections`: исходные секции (`file:`/`symbol:`) идут файловым конвейером двумя плоскими фазами — propagating, затем terminal, — а tier-секции (`DOMAIN_ID_PREFIX`/`PROJECT_ID`) — доменным конвейером волнами зависимостей leaves-first.
- Вводит сквозные конвенции фингерпринтов: блоки штампуются [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint), tier-документы — [`domainMemberFingerprint`](../domains/member-evidence.codelore.md#domainmemberfingerprint), документации зависимостей — [`dependencyDocsFingerprint`](../llm/file-pipeline.codelore.md#dependencydocsfingerprint); отклонённые и пустые блоки тоже получают штамп, чтобы последующие прогоны не переспрашивали одно и то же.
- Задаёт единые правила работы с LLM: пару провайдеров writer/verify создаёт [`createProviderPair`](#codeloreservicecreateproviderpair), промпт партиционирования ограничен бюджетом модели через `assertRequestFitsBudget`, невалидный ответ LLM повторяется один раз с описанием ошибки через `appendPartitionRetry`.

## На что можно положиться

- Идентификаторы сущностей кодируют вид: `file:`/`symbol:` — исходный код, `DOMAIN_ID_PREFIX` — tier-домен, `PROJECT_ID` — обзорный документ (tier-секция — это и есть её entity id, `domain:<slug>` или `project:`). `sourceFilePathOf` возвращает путь только для исходных id, для tier-ид — undefined; на этом держатся `splitTierSections`, сборка member-данных и поиск владельца секции.
- `resolveTargets` без запрошенных целей возвращает весь `allowedBlocks`, а цель вне allowed-набора бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `MISSING_BLOCK`; поэтому [`runPipelineForSections`](#runpipelineforsections) заранее пересекает запрошенные цели с allowed-набором и пропускает секции, у которых целей не осталось.
- Секция генерируется в обеих фазах и может попасть в сводку дважды: `mergeSectionSummaries` схлопывает записи одной секции в одну с объединением `generatedBlocks`, а `dedupeSkipped` убирает из skipped секции, которые записала другая фаза.
- `scopeFromParts` с пустыми списками возвращает undefined — отсутствие фильтра, а не пустой набор; [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) в этом случае видит все секции репозитория, поэтому вызывающие передают undefined только когда скоупа нет вовсе.

## От чего зависит

Файл подключает всё окружение сервиса: [`loadConfig`](../config.codelore.md#loadconfig) и [`resolveTerms`](../config.codelore.md#resolveterms) (`src/config.ts`) дают конфигурацию и термины для файла/языка; [`JsonStorage`](../storage/json-storage.codelore.md#jsonstorage), [`DocStateStorage`](../storage/doc-state-storage.codelore.md#docstatestorage), [`IndexManager`](index-manager.codelore.md#indexmanager) — состояние на диске, индексы кода и документации. Индекс/граф: [`buildCodeIndex`](../indexer/code-indexer.codelore.md#buildcodeindex), [`parseUnifiedDiff`](../graph/diff.codelore.md#parseunifieddiff), [`buildFileDag`](../graph/file-dag.codelore.md#buildfiledag), [`buildDomainDag`](../graph/domain-dag.codelore.md#builddomaindag), [`dependencyWaves`](../graph/waves.codelore.md#dependencywaves), [`getAffectedSectionsForEntities`](../graph/impact.codelore.md#getaffectedsectionsforentities), [`getImpactForEntity`](../graph/impact.codelore.md#getimpactforentity) и константы/функции `DOMAIN_ID_PREFIX`, `PROJECT_ID`, [`domainIdFor`](../indexer/domain-entities.codelore.md#domainidfor), [`isDomainTierEntity`](../indexer/domain-entities.codelore.md#isdomaintierentity), [`isSourceCodeEntity`](../indexer/domain-entities.codelore.md#issourcecodeentity) дают карту сущностей, рёбер и волн. Доменные чистые функции: [`buildPartitionRequest`](../domains/partition.codelore.md#buildpartitionrequest)/[`parsePartitionResponse`](../domains/partition.codelore.md#parsepartitionresponse), [`buildAssignRequest`](../domains/assign.codelore.md#buildassignrequest)/[`parseAssignResponse`](../domains/assign.codelore.md#parseassignresponse), [`domainCoverage`](../domains/domain-map.codelore.md#domaincoverage)/[`fileToDomainSlug`](../domains/domain-map.codelore.md#filetodomainslug), [`collectDomainMemberEvidence`](../domains/member-evidence.codelore.md#collectdomainmemberevidence)/[`domainMemberFingerprint`](../domains/member-evidence.codelore.md#domainmemberfingerprint) — формирование и разбор LLM-сообщений и отпечатки tier-членов. LLM-слой: [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) (фабрика провайдеров и их бюджет), [`generateFileGroup`](../llm/file-pipeline.codelore.md#generatefilegroup), [`generateDomainDoc`](../llm/domain-pipeline.codelore.md#generatedomaindoc), [`verifyBlocksAgainstDeps`](../llm/file-pipeline.codelore.md#verifyblocksagainstdeps), [`collectDependencyDocs`](../llm/file-pipeline.codelore.md#collectdependencydocs)/[`dependencyDocsFingerprint`](../llm/file-pipeline.codelore.md#dependencydocsfingerprint), [`translateBlocks`](../llm/translator.codelore.md#translateblocks), `writeRunDecisions`. Разметка/состояние: [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint), [`translationSourceFingerprint`](../markdown/block-facets.codelore.md#translationsourcefingerprint), [`docResponsibilities`](../markdown/linkify.codelore.md#docresponsibilities), [`renderSection`](../markdown/render-doc.codelore.md#rendersection), `BLOCK_IDS`/`BlockId`. Внутренние модули той же директории (`prepare-docs`, `section-rewrite`, `stale-detection`/`stale-detector`, `doc-reconcile`, `doc-validation`, `domain-docs`, `file-layout`, `index-manager`, `helpers`) задают правила скоупа, томбстоуны, перезапись, проверки и планы раскладки.

## Чего не делает

На уровне файла действуют три рамки:
- `assertRequestFitsBudget` суммирует длины всех `message.content` промпта партиционирования и при `estimatedTokens > maxPromptTokens` бросает `PARTITION_TOO_LARGE`; текст ошибки прямо говорит `Batched partition is not yet implemented`, поэтому слишком большой набор файлов нельзя разбить одним запросом — нужен меньший вход.
- Невалидный ответ LLM переспрашивается ровно один раз: в [`partitionDomainMap`](#codeloreservicepartitiondomainmap) и [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) повторный [`parsePartitionResponse`](../domains/partition.codelore.md#parsepartitionresponse)/[`parseAssignResponse`](../domains/assign.codelore.md#parseassignresponse) стоит вне `try`, значит второй сбой парсинга пробрасывается наверх и останавливает команду без дальнейших попыток.
- `readGitDiff` ловит любую ошибку `execFile` и молча возвращает пустую строку; если вызывающий не передал `diff` и `changedFiles` явно, [`analyzeChange`](#analyzechange) увидит пустой diff и не сообщит о сбое git.

# CodeloreService

```ts
class CodeloreService
```

## Зачем это нужно

Координирует переписывание секций документации: валидирует входные данные, перестраивает индексы, нормализует запросы, группирует их по документам, применяет изменения и обновляет индексы документов, возвращая сводку обновлённых секций.

## Что делает

- Перестраивает и держит актуальными индексы проекта: [`rebuildIndexes`](#rebuildindexes)/[`loadOrRebuildIndexes`](#loadorrebuildindexes) строят индекс кода и документации через [`IndexManager`](index-manager.codelore.md#indexmanager), [`patchDocIndexForDocs`](#patchdocindexfordocs) инкрементально обновляет doc-индекс после записи, а каждая перестройка сбрасывает кэш `projectContextCache`.
- Запускает генерацию и применяет её результаты: [`runPipelineForSections`](#runpipelineforsections) гоняет исходные секции через [`generateFileGroup`](../llm/file-pipeline.codelore.md#generatefilegroup) с лимитом `pLimit(config.llm.concurrency)`, фазы выполняются по очереди, запись идёт последовательно через `applyFileGenerationOutcome`; [`generateDomainDocs`](#codeloreservicegeneratedomaindocs) переписывает tier-документы волнами зависимостей.
- Управляет устареванием: [`refreshStaleDocs`](#refreshstaledocs) в режимах report/rewrite_plan/tombstone, `applyTombstones` прячет устаревшие блоки за callout, [`restoreKeptBlocks`](#codeloreservicerestorekeptblocks)/[`stampUnwrittenBlocks`](#codeloreservicestampunwrittenblocks) штампуют фингерпринты, а `gateDepDocsCascade` снимает ложное depDocs-старение факт-чекингом на verify-провайдере.
- Обслуживает внешние запросы: read-методы ([`readDocSection`](#readdocsection), [`readCodeEntity`](#readcodeentity), [`readImpact`](#readimpact), [`readChange`](#readchange), [`readDocFile`](#readdocfile)), [`validateDocs`](#validatedocs) собирает все классы проблем (владельцы, зависимости, stale-блоки, качество, переводы, неохваченные файлы), [`translateScope`](#codeloreservicetranslatescope) дозаполняет переводы во всём скоупе, [`markReviewNeeded`](#markreviewneeded) ставит секции статус `review_needed`.

## На что можно положиться

- [`rewriteSections`](#rewritesections) с пустым массивом возвращает `{ updatedSections: [] }`, не трогая хранилище и индексы; дубликат `sectionId` бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `DUPLICATE_SECTION` до любой записи.
- LLM-вызовы идут параллельно, а запись результатов строго последовательна: [`rewriteSections`](#rewritesections) и [`markReviewNeeded`](#markreviewneeded) мутируют общий doc-индекс, поэтому `applyFileGenerationOutcome` и доменные волны применяются по одному.
- Томбстоун пишет блоку `staleSince`, `staleReason`, `staleFacets` и скрывает его из рендера; [`restoreKeptBlocks`](#codeloreservicerestorekeptblocks) снимает эти поля, заново штампует `fingerprint` и оставляет секцию в статусе `review_needed`; [`stampUnwrittenBlocks`](#codeloreservicestampunwrittenblocks) штампует только блоки с пустым телом, чтобы пустой блок не запрашивался повторно.
- Read-методы бросают типизированные ошибки: [`resolveSection`](#resolvesection) — `UNKNOWN_SECTION`, [`requireSectionState`](#requiresectionstate) — `UNKNOWN_DOC`/`UNKNOWN_SECTION`, [`readCodeEntity`](#readcodeentity) — `UNKNOWN_ENTITY`, [`readChange`](#readchange) — `UNKNOWN_CHANGE`; перед чтением индекс всегда загружается или пересобирается, так что ответ отражает состояние на диске.

## От чего зависит

Класс напрямую владеет четырьмя зависимостями: [`loadConfig`](../config.codelore.md#loadconfig) в конструкторе вместо `this.config`, и три объекта хранилища/индексов — [`JsonStorage`](../storage/json-storage.codelore.md#jsonstorage), [`DocStateStorage`](../storage/doc-state-storage.codelore.md#docstatestorage), [`IndexManager`](index-manager.codelore.md#indexmanager). Способ работы одинаков: [`IndexManager`](index-manager.codelore.md#indexmanager) единственный из них принимает из класса коллбек сброса `projectContextCache`. Весь остальной функционал (доменные парсеры, рендер, графы) класс только импортирует и вызывает из методов, не держит его в полях; провайдеры LLM создаются на лету через [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) внутри [`createProviderPair`](#codeloreservicecreateproviderpair). Таким образом внешний мир классу нужен в двух формах: синтаксические LLM-провайдеры (`ChatCompletionProvider`) и объекты `GenerateDocsRuntime` с хуком `onProgress`, которые приходят от CLI/MCP и отдают продвижение выполнения.

## Кто и как использует

Главный вход — [`runCli`](../cli/run-cli.codelore.md#runcli): для каждой команды создаётся один `new CodeloreService(parsed.rootDir)`, а `runCommand` диспетчирует сценарии (`generate` → [`generateDocsForScope`](#generatedocsforscope), `fix-stale` → [`fixStaleDocs`](#fixstaledocs), `analize-change` → [`analyzeChange`](#analyzechange), `rebuild-index` → [`rebuildIndex`](#rebuildindex)); при этом `runtime.onProgress` получает интерфейс из CLI, поэтому прогресс-сообщения пишутся в stdout. Ошибки класса ловятся в [`runCli`](../cli/run-cli.codelore.md#runcli) и сериализуются в stderr.

Второй путь — MCP: команда `mcp` запускает `startStdioServer({ rootDir })`, а [`createCodeloreServer`](../server/create-server.codelore.md#createcodeloreserver) (та же директория server) поднимает `McpServer` поверх того же сервиса, так что редактор обращается к тем же методам как к инструментам протокола.

Третий путь есть внутри самого класса: [`verifyBlocksAgainstDeps`](../llm/file-pipeline.codelore.md#verifyblocksagainstdeps) получает экземпляр `service` как аргумент и сам читает `service.config.rootDir` и `service.config.llm.concurrency` — здесь класс выступает источником конфига для внешнего валидатора.

## Чего не делает

Три границы класса:

- Доменная карта не создаётся автоматически: [`refreshDomainDocs`](#codeloreservicerefreshdomaindocs) и бесскоупный [`generateDocsForScope`](#generatedocsforscope) при отсутствии сохранённой карты выходят с пустым результатом без единого вызова partition — для появления доменов нужен явный запуск [`partitionDomainMap`](#codeloreservicepartitiondomainmap).
- Переводы дозаполняются только для блоков, которые пропускает генератор `translatableBlocks`: блок должен быть `rendered`, не stale (`staleSince === undefined`) и с непустым телом; скрытые за томбстоун тексты и пустые блоки перевода не получают.
- Параллельность LLM-вызовов упирается в единый лимит `pLimit(this.config.llm.concurrency)`: генерация и переводы делят этот кэп, сколько бы каналов ни запустил вызывающий.

## Как менять и что проверять

- Целевые блоки ограничены разрешённым набором до любой записи: [`runPipelineForSections`](#runpipelineforsections) заранее применяет `const filtered = requested.filter((blockId) => allowed.has(blockId));`, а `resolveTargets` бросает `MISSING_BLOCK` лишь тогда, когда цель всё-таки туда долетела (конструкция `const invalid = requested.filter((id) => !allowed.has(id)); if (invalid.length > 0)`). 

- Фингерпринт зависимостей-документов пишется только по завершении терминальной фазы: код выполняет `await this.recordDepDocsFingerprints(...)` строго под условием `if (phase === "terminal")` — этим держится контракт «depDocs-финпринт валиден только после перегенерации терминальных блоков». 

- Сходимость томбсоундов обеспечивает двойная инконсистентная запись: [`restoreKeptBlocks`](#codeloreservicerestorekeptblocks) снимает stale-поля только если `block.staleSince !== undefined` и затем перетирает `block.fingerprint`, а [`stampUnwrittenBlocks`](#codeloreservicestampunwrittenblocks) штампит только пустые тело (`if (!sectionState || !block || block.body.trim() !== "") { continue; }`).

## rebuildIndexes

```ts
CodeloreService.rebuildIndexes(options: RebuildIndexesOptions = {}): Promise<ProjectIndex>
```

### Зачем это нужно

Запускает полную перестройку индексов, делегируя вызов методу `rebuildIndexes` без передачи аргументов.

### Что делает

Вызывает `rebuildIndexes` и возвращает результат. Не выполняет дополнительной обработки или валидации.

### На что можно положиться

Метод всегда возвращает `Promise<void>` — он не возвращает данных, а только выполняет побочный эффект перестройки индексов. Он делегирует фактическую работу методу `rebuildIndexes`, не принимая аргументов.

### От чего зависит

Метод использует this.docStateStorage и this.config, а также функции normalizeGeneratedRewrite, groupRewritesByDoc, applyRewritesToDoc, patchDocIndexForDocs и класс CodeloreError.

### Кто и как использует

Метод вызывается извне сервиса для перезаписи секций. При пустом входе сразу возвращает пустой результат. При дубликате sectionId выбрасывает ошибку. Затем загружает или пересобирает индексы, нормализует входные данные, группирует по документам, применяет правки к каждому документу и обновляет индекс документации.

### Чего не делает

Метод не обрабатывает пустой массив sections — он возвращает пустой результат без побочных эффектов. Также он не допускает дубликатов sectionId — выбрасывает CodeloreError. Для секций, не найденных в индексе, docPath возвращается как пустая строка.

## rebuildIndex

```ts
CodeloreService.rebuildIndex(input: RebuildIndexInput = {}): Promise<RebuildIndexResult>
```

### Зачем это нужно

Запускает полную перестройку индексов.

### Что делает

Выполняет перестройку индексов и возвращает результат. Не выполняет дополнительной обработки или валидации.

### На что можно положиться

Метод всегда возвращает `Promise<void>` — он не возвращает данных, а только выполняет побочный эффект перестройки индексов. Он не принимает аргументов.

### От чего зависит

Метод использует this.docStateStorage и this.config, а также функции normalizeGeneratedRewrite, groupRewritesByDoc, applyRewritesToDoc, patchDocIndexForDocs и класс CodeloreError.

### Чего не делает

Метод не обрабатывает пустой массив sections — он возвращает пустой результат без побочных эффектов. Также он не допускает дубликатов sectionId — выбрасывает CodeloreError. Для секций, не найденных в индексе, docPath возвращается как пустая строка.

## patchDocIndexForDocs

```ts
CodeloreService.patchDocIndexForDocs(docPaths: string[]): Promise<void>
```

### Зачем это нужно

Инициирует обновление индексов документов после применения переписываний, делегируя вызов методу `patchDocIndexes` с переданным списком путей.

### Что делает

Принимает массив строк `docPaths` и передаёт его в `patchDocIndexes`, возвращая результат этого вызова. Не выполняет дополнительной обработки или валидации.

### На что можно положиться

Метод всегда возвращает `Promise<void>` — он не возвращает данных, а только выполняет побочный эффект обновления индексов. Он делегирует фактическую работу методу `patchDocIndexes`, передавая ему массив путей документов.

### От чего зависит

Метод использует this.docStateStorage и this.config, а также функции normalizeGeneratedRewrite, groupRewritesByDoc, applyRewritesToDoc, patchDocIndexForDocs и класс CodeloreError.

### Кто и как использует

Метод вызывается извне сервиса для перезаписи секций. При пустом входе сразу возвращает пустой результат. При дубликате sectionId выбрасывает ошибку. Затем загружает или пересобирает индексы, нормализует входные данные, группирует по документам, применяет правки к каждому документу и обновляет индекс документации.

### Чего не делает

Метод не обрабатывает пустой массив sections — он возвращает пустой результат без побочных эффектов. Также он не допускает дубликатов sectionId — выбрасывает CodeloreError. Для секций, не найденных в индексе, docPath возвращается как пустая строка.

## loadOrRebuildIndexes

```ts
CodeloreService.loadOrRebuildIndexes(): Promise<ProjectIndex>
```

### Зачем это нужно

Loads or rebuilds the code and docs indexes for the service, ensuring the service has up-to-date index data.

### Что делает

Checks for cached indexes and loads them if present, otherwise rebuilds them from the source files. It returns the loaded or rebuilt indexes.

### На что можно положиться

The method returns a promise that resolves to an Indexes object containing code and docs indexes. The indexes are loaded from cache if available, otherwise rebuilt.

### От чего зависит

The method depends on the index loader (indexLoader) and the file system to load or rebuild the indexes. It does not call any other service methods.

### Кто и как использует

Called by getSectionContext to ensure the index is loaded before resolving the section. The caller uses the loaded index to resolve the section and its entities.

### Чего не делает

The method only loads or rebuilds the indexes; it does not handle concurrent access to the indexes. It relies on the index loader to be correct; if the loader fails, the indexes may be incomplete.

## analyzeChange

```ts
CodeloreService.analyzeChange(input: AnalyzeChangeInput = {}): Promise<ChangeAnalysis>
```

### Зачем это нужно

Analyzes a change to determine its impact on the codebase, producing a summary and a list of affected files.

### Что делает

Computes the change analysis by comparing the old and new code states. It identifies added, removed, and modified files. It also generates a summary of the changes.

### На что можно положиться

The method returns a ChangeAnalysis object with a summary and a list of Change objects, each containing a changeType, description, and affectedFiles. The changeType is one of 'added', 'removed', or 'modified'. The affectedFiles array contains file paths that are affected by the change.

### От чего зависит

The method depends on the code index (index.code.entities) and docs index (index.docs.sections) to resolve entities and sections. It also calls rebuildIndexes, readGitDiff, parseUnifiedDiff, changedEntitiesFromDiff/changedEntitiesFromFiles, getAffectedSectionsForEntities, and storage.saveChangeAnalysis.

### Чего не делает

The method analyzes changes across the entire index, computing changedFiles, changedEntities, and affected sections. It relies on the index to be up-to-date; if the index is stale, the analysis may be incomplete.

## getAffectedSections

```ts
CodeloreService.getAffectedSections(entityIds: string[]): Promise<AffectedSection[]>
```

### Зачем это нужно

Determines which sections are affected by a change, returning their IDs.

### Что делает

Computes the affected sections by analyzing the change's impact on the codebase. It returns an array of section IDs.

### На что можно положиться

The method returns an array of section IDs that are affected by the change. The array is empty if no sections are affected.

### От чего зависит

The method depends on the code index (index.code.entities) and docs index (index.docs.sections) to resolve entities and sections. It calls loadOrRebuildIndexes and getAffectedSectionsForEntities.

### Чего не делает

The method only considers sections that are directly or transitively dependent on the changed entities; it does not consider sections that depend on the changed section's documentation. It relies on the index to be up-to-date; if the index is stale, the affected sections may be incomplete.

## prepareInitialDocs

```ts
CodeloreService.prepareInitialDocs(input: PrepareInitialDocsInput = {}): Promise<PrepareInitialDocsResult>
```

### Зачем это нужно

Prepares initial documentation for the service, generating docs from the source files.

### Что делает

Scans the source files and generates initial docs for each file. It returns an array of Doc objects.

### На что можно положиться

The method returns a promise that resolves to an array of Doc objects. The docs are prepared from the source files.

### От чего зависит

The method depends on the index's docs sections (index.docs.sections) and the file system to prepare initial docs. It calls this.rebuildIndexes({ renderDocs: false }) near the end of the method.

### Кто и как использует

Called by getSectionContext to ensure initial docs are prepared before resolving the section. The caller uses the prepared docs to resolve the section.

### Чего не делает

The method prepares initial docs for missing entities regardless of whether the index is empty. It computes missingEntities from scopedEntities and documentedEntities, and proceeds to create sections for them without any emptiness guard.

### Как менять и что проверять

The method processes missingEntities and writes doc state sections, preserving previous block bodies via withPreservedBlockBodies.

## getSectionContext

```ts
CodeloreService.getSectionContext(sectionId: string, reason?: string, options: { includeProjectContext?: boolean; targets?: BlockId[] } = {}): Promise<SectionContext>
```

### Зачем это нужно

Builds a comprehensive context for a section, including its owned entities, dependencies, and rewrite instructions, to support section-level operations.

### Что делает

Resolves the section, collects owned and dependent entities, computes direct usages, finds neighbor sections, optionally includes project context, collects allowed blocks, and resolves targets. It then assembles the SectionContext object.

### На что можно положиться

The method returns a SectionContext object with a section summary, targets, rewrite instructions, owned entities, dependencies, direct usages, neighbor sections, allowed blocks, skipped blocks, reason, and project context. The section summary is a summarized version of the section. The targets are resolved from the options. The rewrite instructions are built from the targets and allowed blocks. The owned entities are the entities that the section owns. The dependencies are the entities that the section depends on. The direct usages are the entities that the owned entities directly use. The neighbor sections are the sections in the same file, excluding the current section. The allowed blocks are the blocks that are allowed for the section. The skipped blocks are the blocks that are skipped. The reason is the reason provided. The project context is the project context if included.

### От чего зависит

The method depends on the index's code entities (index.code.entities) and docs sections (index.docs.sections) to resolve entities and sections. It also calls getProjectContext to obtain project context when includeProjectContext is true.

### Чего не делает

The method only returns a SectionContext for the given sectionId; it does not handle missing sections gracefully. It relies on the index to be up-to-date; if the index is stale, the section context may be incomplete.

## getProjectContext

```ts
CodeloreService.getProjectContext(): Promise<ProjectContext | undefined>
```

### Зачем это нужно

Retrieves project-level context for use in section context, providing a snapshot of the project's overall state.

### Что делает

Gathers project-level information from the index and returns it as a ProjectContext object. It includes the project name, description, and dependencies.

### На что можно положиться

The method returns a ProjectContext object containing project-level information such as the project name, description, and dependencies.

### От чего зависит

The method checks this.projectContextCache and calls this.readProjectContext() to build the ProjectContext.

### Кто и как использует

Called by getSectionContext when includeProjectContext is true (default), providing the project context for the section context. The caller uses the returned ProjectContext to populate the projectContext field of the SectionContext.

### Чего не делает

The method only returns project-level information; it does not include any section-specific data.

## rewriteSection

```ts
CodeloreService.rewriteSection(sectionId: string, input: Omit<RewriteSectionInput, "sectionId">): Promise<{ sectionId: string; docPath: string; filteredBlocks?: FilteredGeneratedBlock[] }>
```

### Зачем это нужно

Заменяет содержимое секции новым текстом, обеспечивая актуальность документации.

### Что делает

Проверяет существование секции и, если она есть, записывает в неё новый текст. Если секции нет, метод завершается без изменений.

### На что можно положиться

Метод перезаписывает содержимое секции, заменяя его новым текстом. Если секция не существует, метод не выполняет никаких действий.

### От чего зависит

Использует вспомогательные функции для перезаписи секции.

### Чего не делает

Не создаёт новые секции — только перезаписывает содержимое существующих.

## rewriteSections

```ts
CodeloreService.rewriteSections(sections: RewriteSectionInput[]): Promise<{
    updatedSections: Array<{ sectionId: string; docPath: string; filteredBlocks?: FilteredGeneratedBlock[] }>;
  }>
```

### Зачем это нужно

Обновляет несколько секций документации за один вызов, делегируя перезапись каждой отдельной секции методу rewriteSection.

### Что делает

Принимает список секций и для каждой вызывает rewriteSection. Если список пуст, метод не выполняет никаких действий.

### На что можно положиться

Метод перезаписывает несколько секций, применяя rewriteSection к каждой из них. Порядок перезаписи соответствует порядку переданных секций.

### От чего зависит

Зависит от [`applyRewritesToDoc`](section-rewrite.codelore.md#applyrewritestodoc) и [`groupRewritesByDoc`](section-rewrite.codelore.md#grouprewritesbydoc) для перезаписи секций.

### Кто и как использует

Выполняет массовую перезапись переданных секций документации.

### Чего не делает

Не обрабатывает случай, когда переданные секции содержат невалидные данные — он просто перезаписывает их.

### Как менять и что проверять

- Ранний выход при отсутствии секций: если массив секций пуст, метод возвращает `{ updatedSections: [] }`.
- Перезапись секций: метод группирует переданные секции по документам и применяет перезаписи через [`applyRewritesToDoc`](section-rewrite.codelore.md#applyrewritestodoc).

## markReviewNeeded

```ts
CodeloreService.markReviewNeeded(sectionId: string, reason: string): Promise<{ sectionId: string; reason: string }>
```

### Зачем это нужно

Сигнализирует о необходимости ручной проверки сущности, устанавливая соответствующий флаг.

### Что делает

Изменяет состояние сущности, устанавливая флаг, указывающий на необходимость ревью.

### На что можно положиться

Метод помечает сущность как требующую ревью, устанавливая флаг в её состоянии. Вызов метода не возвращает значения и не влияет на другие сущности.

### Кто и как использует

Помечает секцию как требующую ревью.

### Чего не делает

Не выполняет никаких действий, кроме установки флага, и не проверяет, было ли ревью уже запрошено.

### Как менять и что проверять

- Установка статуса ревью: метод безусловно устанавливает `sectionState.status = "review_needed"` и сохраняет состояние.

## validateDocs

```ts
CodeloreService.validateDocs(input: { includeQuality?: boolean } = {}): Promise<{ issues: DocValidationIssue[] }>
```

### Зачем это нужно

Выявляет ошибки в документации, чтобы гарантировать её соответствие требованиям.

### Что делает

Анализирует структуру документации и собирает список найденных проблем. Возвращает этот список вызывающему коду.

### На что можно положиться

Метод проверяет корректность документации и возвращает список ошибок. Если ошибок нет, возвращает пустой список.

### От чего зависит

Использует вспомогательные функции для проверки документации.

### Чего не делает

Не изменяет документацию — только проверяет её корректность.

## refreshStaleDocs

```ts
CodeloreService.refreshStaleDocs(input: RefreshStaleDocsInput = {}): Promise<RefreshStaleDocsResult>
```

### Зачем это нужно

Обновляет документацию для сущностей, помеченных как устаревшие, чтобы синхронизировать её с текущим кодом.

### Что делает

- В любом режиме сначала перестраивает индекс ([`rebuildIndexes`](#rebuildindexes)), фильтрует секции по `input.scope` через [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) и вычисляет списки stale и tombstoned.
- В режиме `report` возвращает оба списка через [`refreshStaleResult`](stale-detection.codelore.md#refreshstaleresult); в `rewrite_plan` дополнительно строит `rewritePlan` из [`buildRewriteContextBundle`](stale-detection.codelore.md#buildrewritecontextbundle) для каждой записи обоих списков.
- В режиме `tombstone` применяет `applyTombstones` к stale-блокам; если записано нечего — возвращает результат без изменений, иначе патчит doc-индекс ([`patchDocIndexForDocs`](#patchdocindexfordocs)), пересобирает индекс и пересчитывает tombstoned уже на обновлённом индексе.

### На что можно положиться

- Режим по умолчанию — `report`; режимы `report` и `rewrite_plan` не изменяют ни состояние документов, ни индексы.
- Пустой `scope` означает отсутствие фильтра: [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) пропускает все секции репозитория, поэтому вызов может затомбстоунить весь проект; [`generateDocsForScope`](#generatedocsforscope) передаёт undefined только когда скоупа нет вовсе.
- В режиме `tombstone` запись происходит только если `applyTombstones` вернул непустой список; при пустом списке устаревших метод возвращает результат, не меняя состояние.
- Возвращённый список устаревших после записи пересчитан на индексе после применения томбстоунов ([`loadOrRebuildIndexes`](#loadorrebuildindexes)), а список до записи остаётся неизменным; [`fixStaleDocs`](#fixstaledocs) строит целевые блоки генерации именно из пересчитанного списка.

### От чего зависит

Метод работает только через соседние модули и собственные помощники класса: [`rebuildIndexes`](#rebuildindexes)/[`loadOrRebuildIndexes`](#loadorrebuildindexes) — перезагрузка индекса; `StaleDetector` — вычисление списков stale и tombstoned; [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope), [`refreshStaleResult`](stale-detection.codelore.md#refreshstaleresult), [`buildRewriteContextBundle`](stale-detection.codelore.md#buildrewritecontextbundle) из `stale-detection.js` — фильр по скоупу, оформление результата и контекст для `rewrite_plan`; `applyTombstones` — единственная запись в state; [`patchDocIndexForDocs`](#patchdocindexfordocs) — инкрементальное обновление doc-индекса после записи.

### Кто и как использует

Метод вызывается из трёх мест прогона:

- [`generateDocsForScope`](#generatedocsforscope) (команда `generate` без `--force`) вызывает `refreshStaleDocs({ mode: "tombstone", scope })` и каждый элемент `refreshed.tombstoned` превращает в цель переген​ерации — так заблокированные блоки попадают в ближайший файловый прогон.
- [`fixStaleDocs`](#fixstaledocs) совершает тот же вызов и строит целевую карту из результата через `targetBlocksFromTombstones(refreshed.tombstoned)`, дальше передавая её в дальнейший прогон.
- `gateDepDocsCascade` вызывает режим `report`, чтобы отобрать секции, устаревшие только по `changedFacets == ["depDocs"]` и потом проверять их на verify-провайдере.
- CLI (`run-cli.ts`) со стороны пользователя дёртится сама — литеральные `report`/`tombstone` там задают режим команды, и результат `report` печатается в stdout.

### Чего не делает

Два ограничения:

- Метод не знает «почему» сделан рендер: он доверяет целиком `StaleDetector`; если детектор посчитал секцию свежей, никакие другие сигналы не проверяются, и в исполняемом режиме не будет создан ни один tombstone.
- При применении рендера `applyTombstones` молча пропускает записи, для которых в состоянии нет секции/блока (`if (!sectionState || !block) { continue; }`), и не сообщает о них: такие находки исчезают из результата и не попадают в дальнейшую перегенерацию.

### Как менять и что проверять

- Безопасный вызов без режима: `const mode = input.mode ?? "report";` вместе с ранним возвратом `if (mode === "report")` гарантируют, что чтение состояния не меняет ни документы, ни индексы.

- В режиме `tombstone` запись происходит только если реально есть что применять: `if (appliedTombstones.length === 0) { return refreshStaleResult(mode, stale, tombstoned, appliedTombstones); }` — пустой список устаревших не оставляет следов на диске.

- После записи список tombstones пересчитывается заново: `new StaleDetector(refreshed, this.config.docs.langage).tombstoned(refreshedScoped)` — результат tombstoned всегда относится к индексу после записи, а не к старому обчислению.

## generateDocsForEntity

```ts
CodeloreService.generateDocsForEntity(input: GenerateDocsForEntityInput, runtime: GenerateDocsRuntime): Promise<GenerateDocsResult>
```

### Зачем это нужно

Собирает итоговую документацию для сущности, объединяя результаты обработки всех её секций.

### Что делает

Получает список секций для сущности через resolveSectionsForId. Прогоняет каждую секцию через runPipelineForSections. Объединяет результаты обработки всех секций в единый вывод.

### На что можно положиться

Метод возвращает результат конкатенации содержимого всех секций, которые возвращает resolveSectionsForId, после прогона каждой через runPipelineForSections. Порядок секций в выводе совпадает с порядком, в котором их возвращает resolveSectionsForId. Метод не изменяет входные данные и не сохраняет состояние между вызовами.

### От чего зависит

Зависит от `resolveSectionsForId`, [`runPipelineForSections`](#runpipelineforsections), [`translateScope`](#codeloreservicetranslatescope) и `scopeFromParts`.

### Чего не делает

Не создаёт новые секции — только генерирует содержимое существующих.

## generateDocsForScope

```ts
CodeloreService.generateDocsForScope(input: GenerateDocsForScopeInput, runtime: GenerateDocsRuntime): Promise<GenerateDocsResult>
```

### Зачем это нужно

The method exists to produce documentation for a scope, which is a collection of entities, by generating docs for each entity individually and aggregating the results.

### Что делает

The method orchestrates documentation generation for a scope by preparing initial docs, reconciling scoped doc states, queueing unwritten blocks, refreshing stale docs, running the pipeline for sections, translating, reconciling rendered docs, and refreshing domain docs. It returns a `GenerateDocsResult`.

### На что можно положиться

The method accepts a `GenerateDocsForScopeInput` and a `GenerateDocsRuntime`. It orchestrates preparation, reconciliation, queueing, refreshing, pipeline execution, translation, and domain refresh. The result is a `GenerateDocsResult`. The input scope is not mutated.

### От чего зависит

Зависит от внутренних методов для фильтрации секций по области.

### Чего не делает

Не предусматривает пропуск ошибок: при сбое перевода одной сущности метод завершается с ошибкой.

### Как менять и что проверять

Обрабатывает область видимости: загружает индексы, фильтрует сущности по scope и запускает перевод для каждой.

## fixStaleDocs

```ts
CodeloreService.fixStaleDocs(input: FixStaleDocsInput, runtime: GenerateDocsRuntime): Promise<GenerateDocsResult>
```

### Зачем это нужно

The method exists to bring stale documentation up to date by regenerating docs for sections that are identified as stale, using the scope filter to determine which sections need attention.

### Что делает

The method orchestrates fixing stale docs by assigning uncovered files, preparing domain docs, gating dep docs cascade, reconciling scoped doc states, refreshing stale docs, queueing unwritten blocks, running the pipeline, translating, generating domain docs, reconciling rendered docs, gating dep docs again, and recording run decisions. It returns a `GenerateDocsResult`.

### На что можно положиться

The method accepts a `FixStaleDocsInput` and a `GenerateDocsRuntime`. It orchestrates multiple steps including assignUncoveredFiles, prepareDomainDocs, gateDepDocsCascade, reconcileScopedDocStates, refreshStaleDocs, queueUnwrittenBlocks, runPipelineForSections, translateScope, generateDomainDocs, reconcileRenderedDocs, gateDepDocsCascade, and recordRunDecisions. The input sections are not mutated; the method returns a new result object.

### От чего зависит

Зависит от внутренних методов для фильтрации секций.

### Чего не делает

Не предусматривает частичную обработку: при сбое одного документа процесс прерывается.

## appendGenerationHistory

```ts
CodeloreService.appendGenerationHistory(docPath: string, sectionId: string, entry: GenerationHistoryEntry): Promise<void>
```

### Зачем это нужно

The method exists to record a new generation event by appending it to a history array, so callers can accumulate a chronological log of generation actions.

### Что делает

The method takes a docPath, sectionId, and entry, loads the doc state, appends the entry to the section's generationHistory, updates generatedAt, and persists via renderAndPersist. It returns Promise<void>.

### На что можно положиться

The method accepts docPath, sectionId, and entry. It loads the doc state, appends the entry to the section's generationHistory, updates generatedAt, and persists. It returns Promise<void>.

### От чего зависит

Использует структуру `GenerateDocsResult` для хранения истории; не вызывает внешних модулей.

### Кто и как использует

Вызывается из трёх публичных методов сервиса после успешного выполнения генерации, чтобы зафиксировать факт операции.

### Чего не делает

Не выполняет дедупликацию: каждая запись добавляется в конец `generationHistory` без проверки на существование.

### Как менять и что проверять

Добавляет запись о завершённой генерации в массив `generationHistory` объекта результата, сохраняя метаданные операции для последующего аудита и отладки.

## runPipelineForSections

```ts
CodeloreService.runPipelineForSections(sectionIds: string[], intent: string | undefined, runtime: GenerateDocsRuntime, targetBlocksBySection: ReadonlyMap<string, BlockId[]> = new Map()): Promise<GenerateDocsResult>
```

### Зачем это нужно

The method exists to apply the documentation generation pipeline to a batch of sections, producing a combined result with all generated docs and history.

### Что делает

The method groups sections by file, filters target blocks by allowed set, runs two phases (propagating and terminal) via generateFileGroup, applies outcomes via applyFileGenerationOutcome, and returns a GenerateDocsResult with updatedSections, skipped, failed, and updatedFiles.

### На что можно положиться

The method accepts sectionIds, intent, runtime, and targetBlocksBySection. It groups sections by file and processes files concurrently with pLimit. It returns a GenerateDocsResult with updatedSections, skipped, failed, and updatedFiles.

### От чего зависит

Зависит от внутренних методов для перевода и записи результата.

### Кто и как использует

Вызывается из методов генерации и исправления устаревших документов для обработки списка секций.

### Чего не делает

Не предусматривает изоляцию ошибок: исключение в одной секции прерывает обработку остальных.

### Как менять и что проверять

Обрабатывает каждую секцию через общий конвейер, включая перевод и запись истории.

## recordDepDocsFingerprints

```ts
CodeloreService.recordDepDocsFingerprints(writtenSections: Array<{ sectionId: string; docPath: string }>): Promise<void>
```

### Зачем это нужно

The method exists to store dependency doc fingerprints in the runtime state, enabling change detection in subsequent operations.

### Что делает

The method takes writtenSections, loads the index, groups by docPath, loads doc states, computes dependency docs fingerprints per file, sets sectionState.depDocsFingerprint, and persists via renderAndPersist. It returns Promise<void>.

### На что можно положиться

The method accepts writtenSections. It stores fingerprints in doc state sections and returns Promise<void>.

### От чего зависит

Не вызывает внешних зависимостей; оперирует только переданными данными.

### Кто и как использует

Вызывается после завершения перевода, чтобы сохранить отпечатки для будущих проверок.

### Чего не делает

Не выполняет валидацию отпечатков; предполагает, что они уже корректны.

### Как менять и что проверять

Записывает хэши или контрольные суммы документации зависимостей, чтобы позже определять устаревшие записи.

## readDocSection

```ts
CodeloreService.readDocSection(sectionId: string): Promise<string>
```

### Зачем это нужно

Enables callers to fetch the rendered content of a Codelore section, with a null result when the section does not exist.

### Что делает

Delegates the actual retrieval and rendering to readCodeloreSection, returning the same result. Does not perform any additional processing or error handling beyond what the delegate does.

### На что можно положиться

Returns the rendered section content as a string, or null when the section is not found. The rendering follows the same rules as readDocSection, using the section state and the service configuration.

### От чего зависит

The method depends on the service's own resolveSection and requireSectionState helpers and the imported renderSection function.

### Чего не делает

The method only renders the section state; it does not modify any state or index. The early return in resolveSection when the section is not found prevents any rendering for unknown sections.

## readCodeEntity

```ts
CodeloreService.readCodeEntity(entityId: string): Promise<unknown>
```

### Зачем это нужно

Enables callers to fetch the rendered content of a Codelore entity, with a null result when the entity does not exist.

### Что делает

Delegates the actual retrieval and rendering to readCodeloreSection, returning the same result. Does not perform any additional processing or error handling beyond what the delegate does.

### На что можно положиться

Returns the rendered entity content as a string, or null when the entity is not found. The rendering follows the same rules as readDocSection, using the section state and the service configuration.

### От чего зависит

The method depends on the service's own resolveSection and requireSectionState helpers and the imported renderSection function.

### Чего не делает

The method only renders the section state; it does not modify any state or index. The early return in resolveSection when the section is not found prevents any rendering for unknown sections.

## readImpact

```ts
CodeloreService.readImpact(entityId: string): Promise<unknown>
```

### Зачем это нужно

Enables callers to fetch the rendered content of a Codelore impact, with a null result when the impact does not exist.

### Что делает

Delegates the actual retrieval and rendering to readCodeloreSection, returning the same result. Does not perform any additional processing or error handling beyond what the delegate does.

### На что можно положиться

Returns the rendered impact content as a string, or null when the impact is not found. The rendering follows the same rules as readDocSection, using the section state and the service configuration.

### От чего зависит

The method depends on the service's own resolveSection and requireSectionState helpers, the imported renderSection function, and the service's patchDocIndexForDocs method.

### Чего не делает

The method only updates the section state and the doc index; it does not re-render the full document or update other sections. The early return in resolveSection when the section is not found prevents any state mutation for unknown sections.

## readChange

```ts
CodeloreService.readChange(changeId: string): Promise<ChangeAnalysis>
```

### Зачем это нужно

Enables callers to fetch the rendered content of a Codelore section, with a null result when the section does not exist.

### Что делает

Delegates the actual retrieval and rendering to readCodeloreSection, returning the same result. Does not perform any additional processing or error handling beyond what the delegate does.

### На что можно положиться

Returns the rendered section content as a string, or null when the section is not found. The rendering follows the same rules as readDocSection, using the section state and the service configuration.

### От чего зависит

The method depends on the service's own resolveSection and requireSectionState helpers, the imported renderSection function, and the service's patchDocIndexForDocs method.

### Чего не делает

The method only updates the section state and the doc index; it does not re-render the full document or update other sections. The early return in resolveSection when the section is not found prevents any state mutation for unknown sections.

## readDocFile

```ts
CodeloreService.readDocFile(docPath: string): Promise<string>
```

### Зачем это нужно

Enables callers to fetch the rendered content of a Codelore document, with a null result when the document does not exist.

### Что делает

Delegates the actual retrieval and rendering to readCodeloreSection, returning the same result. Does not perform any additional processing or error handling beyond what the delegate does.

### На что можно положиться

Returns the rendered document content as a string, or null when the document is not found. The rendering follows the same rules as readDocSection, using the section state and the service configuration.

### От чего зависит

The method depends on the service's own resolveSection and requireSectionState helpers, the imported renderSection function, and the service's patchDocIndexForDocs method.

### Чего не делает

The method only renders sections that have a non-empty state; sections without a state are skipped. The early return in resolveSection when the section is not found prevents any rendering for unknown sections.

### Как менять и что проверять

- The method enforces that only sections with a non-empty state are rendered, via the `filter(Boolean)` on `sectionStates`.
- The method enforces that the document is rendered only if at least one section has a non-empty state, via the `if (renderedSections.length === 0) return ""` guard.

## resolveSection

```ts
CodeloreService.resolveSection(sectionId: string): Promise<{ index: ProjectIndex; section: DocSection }>
```

### Зачем это нужно

Resolves a section ID to its metadata, throwing an error if not found.

### Что делает

Loads or rebuilds the index via loadOrRebuildIndexes, then looks up the section by ID. If the section is missing, throws CodeloreError.

### На что можно положиться

Throws CodeloreError when the section is not found in the index. The index is loaded or rebuilt via loadOrRebuildIndexes before lookup.

### От чего зависит

The method depends on the service's own loadOrRebuildIndexes method and the imported CodeloreError class.

### Кто и как использует

All read and write methods in the service call resolveSection first to obtain the section and index. The method is invoked by readDocSection, readDocFile, readCodeEntity, readImpact, and readCodeloreService, each passing a sectionId.

### Чего не делает

The method throws an error if the section is not found; it does not return a fallback. The guard `if (!section) throw new CodeloreError(...)` enforces this.

### Как менять и что проверять

- The method enforces that the section must exist in the index, via the `if (!section) throw new CodeloreError(...)` guard.
- The method enforces that the index is loaded or rebuilt before resolving, via the `await this.loadOrRebuildIndexes()` call.

## requireSectionState

```ts
CodeloreService.requireSectionState(docPath: string, sectionId: string): Promise<{ state: DocState; sectionState: DocStateSection }>
```

### Зачем это нужно

Provides a guarded lookup that either returns the section's state and section object or fails fast with a typed error, so callers can rely on the section being present before they read or write its blocks.

### Что делает

- Looks up the section by `sectionId` within the doc's state; if absent, throws a [`CodeloreError`](../errors.codelore.md#codeloreerror) with code `"SECTION_NOT_FOUND"` and a message that includes the section id.
- Returns a promise resolving to an object with `state` (the `DocState` that owns the section) and `section` (the `DocSection` itself), enabling the caller to both read and mutate the section.

### На что можно положиться

Returns a Promise resolving to `{ state, section }` where `section` is the `DocSection` for the given `sectionId` in the doc at `docPath`. If the section does not exist, rejects with a [`CodeloreError`](../errors.codelore.md#codeloreerror) carrying code `"SECTION_NOT_FOUND"` and a message that includes the section id. The returned `state` is the `DocState` object that owns the section, so callers can mutate the section through it.

### От чего зависит

The method relies on the `DocState` type and the [`CodeloreError`](../errors.codelore.md#codeloreerror) class, both defined in the same file, and on the `DocSection` type from the markdown module. It does not depend on any external modules beyond those already imported by the file.

### Кто и как использует

Callers invoke this method when they need to read or mutate a section's blocks. The method either returns the section's state and section object, or rejects with a typed error, so callers can proceed without additional existence checks. The returned `state` is the `DocState` that owns the section, enabling mutation through it.

### Чего не делает

The method only works with sections that already exist in the doc's state; it does not create missing sections. If the section is absent, it rejects with a [`CodeloreError`](../errors.codelore.md#codeloreerror) rather than returning a default or empty section.

### Как менять и что проверять

The method enforces a fail-fast contract: when the section is absent, it rejects with a [`CodeloreError`](../errors.codelore.md#codeloreerror) whose code is `"SECTION_NOT_FOUND"` and whose message includes the section id. The returned `state` is the `DocState` object that owns the section, so callers can mutate the section through it. The method never returns a section without its owning state, and never returns a state without the section — the two always come together.

# CodeloreService.translateScope

```ts
CodeloreService.translateScope(scope: RefreshStaleScope | undefined, runtime: GenerateDocsRuntime): Promise<void>
```

## Зачем это нужно

The method exists to produce translated documentation for a scope, which is a collection of entities, by translating each entity individually and aggregating the results.

## Что делает

The method filters sections by scope, groups by docPath, collects source paths, creates a provider, and calls translateDoc per docPath with concurrency limit. It returns Promise<void>.

## На что можно положиться

The method accepts scope (RefreshStaleScope | undefined) and runtime. It filters sections by scope, groups by docPath, and calls translateDoc per docPath. It returns Promise<void>.

## От чего зависит

Зависит от `runPipelineForSection` для обработки секций и от `pLimit` для ограничения числа параллельных операций.

## Кто и как использует

Вызывается из [`generateDocsForScope`](#generatedocsforscope) после подготовки секций для запуска перевода.

## Чего не делает

Не предусматривает частичный успех: если одна секция завершается ошибкой, весь перевод области прерывается.

## Как менять и что проверять

Обрабатывает область: получает секции, применяет конвейер с ограничением параллельности и возвращает результат.

# CodeloreService.reconcileScopedDocStates

```ts
CodeloreService.reconcileScopedDocStates(scope: RefreshStaleScope | undefined): Promise<void>
```

## Зачем это нужно

The method reconciles scoped doc states, likely merging or updating states based on some rule.

## Что делает

The method reconciles scoped doc states, likely merging or updating states based on some rule.

## На что можно положиться

The method reconciles scoped doc states, likely merging or updating states based on some rule.

## Чего не делает

Ограничений нет.

# CodeloreService.prepareDomainDocs

```ts
CodeloreService.prepareDomainDocs(): Promise<{ docPaths: string[] }>
```

## Зачем это нужно

The method prepares domain documentation by partitioning the map and gathering tier dependencies and members.

## Что делает

The method calls parititionDomainMap, then for each partition calls gatherTierDependencies and gatherTierMembers, and combines results.

## На что можно положиться

- Возвращает `docPaths` в отсортированном порядке (`.sort()`).
- `deleteOrphanTierDocs` удаляет ровно те tier-документы — обзорный документ проекта и пути с префиксом `docs/domains/`, — которых нет в текущем наборе скелетов; при пустом наборе это все tier-документы.
- Код загружает существующее состояние документа, но записывает исходный `skeleton`: результат [`withPreservedBlockBodies(previous, skeleton.sections[sectionId])`](prepare-docs.codelore.md#withpreservedblockbodies) и скопированный `previous.memberDocsFingerprint` присваиваются локальной `fresh`, которая не возвращается в скелет; на диск уходит `skeleton`.
- После записи всех скелетов метод всегда перестраивает индекс ([`rebuildIndexes({ renderDocs: false })`](#rebuildindexes)) и вызывает [`reconcileRenderedDocs`](#codeloreservicereconcilerendereddocs), так что к возврату рендеры сходятся с состоянием.

## Кто и как использует

Метод стоит в начале всех трёх доменных прогонов:

- [`generateDomainDocs`](#codeloreservicegeneratedomaindocs) первым же оператором вызывает `await this.prepareDomainDocs()`, и только после этого читает карту и строит волны — так волны гарантировано опираются на актуальные скелеты tier-документов.
- [`refreshDomainDocs`](#codeloreservicerefreshdomaindocs) вызывает сначала назначение неохваченных файлов, затем `prepareDomainDocs()` — сначала распределение неохваченных файлов меняет членство, затем скелеты пересобраны.
- [`fixStaleDocs`](#fixstaledocs) по той же схеме: назначение файлов, затем `prepareDomainDocs()`, затем обновление томпстоун-скоупа.

## Чего не делает

Скоуп метода узко ограничен tier-документацией: удаление осществляет только по путям проектных документов и префиксу `docs/domains/`, файловые doc-state при этом не трогаются. Метод ни пишет ни одной LLM-генерации: тексты блоков в скелетах пусты либо сохранены как было, и наполнение происходит позже в [`generateDomainDocs`](#codeloreservicegeneratedomaindocs).

## Как менять и что проверять

- Граница удаления осиротевших стабильна: в `deleteOrphanTierDocs` код проверяет `const isTierDoc = docPath === overview || docPath.startsWith("docs/domains/");` — только такая запись может быть удалена.

- После записи скелетов индексацию и рендер доводит последовательность: `await this.rebuildIndexes({ renderDocs: false });` затем `await this.reconcileRenderedDocs();` — гарантия, что по выходе метод оставляет дисковый индекс и отрендеренные doc-файлы в согласованном виде.

# CodeloreService.partitionDomainMap

```ts
CodeloreService.partitionDomainMap(runtime: GenerateDocsRuntime): Promise<{ domains: number; files: number }>
```

## Зачем это нужно

The method partitions a map of domain IDs to members into two maps: one for domain-prefixed keys and one for the rest.

## Что делает

The method iterates the input map, checks each key against DOMAIN_ID_PREFIX, and assigns to the appropriate output map.

## На что можно положиться

The method partitions a map of domain IDs to members into two maps: one for domain-prefixed keys and one for the rest.

## Чего не делает

Ограничений нет.

# CodeloreService.generateDomainDocs

```ts
CodeloreService.generateDomainDocs(runtime: GenerateDocsRuntime, options: { slugs?: ReadonlySet<string> } = {}): Promise<{ generated: string[]; droppedBlocks: number; failed: Array<{ slug: string; error: string }> }>
```

## Зачем это нужно

The method is the public entry point that produces domain documentation for a given code entity, leveraging the project index and file members.

## Что делает

The method invokes gatherTierDependencies and gatherTierMembers to collect the dependency and member lists, then assembles them into a DomainWriteResult.

## На что можно положиться

The method returns a Promise<DomainWriteResult> and is the public entry point that orchestrates the two private helpers.

## Кто и как использует

Вызывается из `gatherTierMembers` для каждого идентификатора зависимости, начинающегося с `DOMAIN_ID_PREFIX`, чтобы получить сводку доменного документа.

## Чего не делает

Ограничений нет.

# CodeloreService.domainDocSummary

```ts
CodeloreService.domainDocSummary(domainId: string, index: ProjectIndex): Promise<DomainWriteMember | undefined>
```

## Зачем это нужно

The method resolves a dependency ID to a domain documentation summary, returning undefined when no summary exists.

## Что делает

The method is invoked by gatherTierDependencies and gatherTierMembers for each dependency ID that starts with DOMAIN_ID_PREFIX; it returns a summary or undefined, and callers skip the dependency when undefined.

## На что можно положиться

The method returns a DomainWriteMember or undefined; callers treat undefined as 'skip this dependency'. The returned summary's sections array is guaranteed to have at least one element when the summary exists, as gatherTierDependencies accesses sections[0] without a guard.

## От чего зависит

Использует [`domainDocPath`](domain-docs.codelore.md#domaindocpath) для получения пути к файлу доменного документа по идентификатору зависимости.

## Кто и как использует

Вызывается из `gatherTierMembers` для каждого идентификатора зависимости, начинающегося с `DOMAIN_ID_PREFIX`, чтобы получить сводку доменного документа.

## Чего не делает

Ограничений нет.

# CodeloreService.collectDocumentedFileLeads

```ts
CodeloreService.collectDocumentedFileLeads(index: ProjectIndex): Promise<Array<{ path: string; lead: string }>>
```

## Зачем это нужно

Метод собирает идентификаторы файлов, которые уже имеют документацию, чтобы использовать их для исключения из последующей обработки.

## Что делает

- Принимает массив идентификаторов файлов и возвращает новый массив, содержащий те идентификаторы, для которых в `this.documentedFiles` есть запись.
- Не изменяет состояние сервиса и не влияет на другие коллекции.
- Не выполняет дедупликацию и не сортирует результат.

## На что можно положиться

Метод возвращает массив строк. При вызове с пустым массивом `files` возвращает пустой массив. При вызове с массивом, содержащим дубликаты идентификаторов файлов, возвращает массив с дубликатами, так как не выполняет дедупликацию. Метод не изменяет состояние сервиса и не имеет побочных эффектов. Метод не проверяет, существует ли файл с указанным идентификатором в системе, и не выбрасывает исключений при отсутствии такого файла.

## От чего зависит

Использует провайдера LLM для извлечения заголовков из файлов.

## Кто и как использует

Вызывается в начале процесса для сбора заголовков; результаты используются для дальнейшей обработки.

## Чего не делает

Не обрабатывает файлы, у которых отсутствует документация — они пропускаются.

## Как менять и что проверять

Собирает документационные заголовки файлов.

# CodeloreService.refreshDomainDocs

```ts
CodeloreService.refreshDomainDocs(runtime: GenerateDocsRuntime): Promise<{ generated: string[]; droppedBlocks: number; failed: Array<{ slug: string; error: string }> }>
```

## Зачем это нужно

Метод обновляет внутренний кэш доменных документов, чтобы отражать последние изменения.

## Что делает

- Возвращает пустой результат `{ generated: [], droppedBlocks: 0, failed: [] }`, если карты доменов нет (метод получения карты вернул undefined): проект без доменов метод не трогает.
- При наличии карты распределяет задокументированные файлы без домена через [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) (один лёгкий LLM-вызов на verify-провайдере), пересобирает скелеты через [`prepareDomainDocs`](#codeloreservicepreparedomaindocs) и перестраивает индекс.
- Вычисляет устаревшие tier-слаги; если их нет — возвращает empty, иначе передаёт их в [`generateDomainDocs`](#codeloreservicegeneratedomaindocs) с опцией `{ slugs }`, чтобы переписать только изменившиеся tier-документы, и возвращает его результат.

## На что можно положиться

- Вызов безопасен в любом состоянии: без карты доменов метод выходит до перестройки индексов и записи; при пустом наборе устаревших слагов он доходит до возврата empty после пересборки скелетов, но tier-документы не переписывает.
- [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) выполняется до вычисления устаревания: добавление файла меняет членство домена, и принимающий домен попадает в список устаревших tier-документов этого же прогона.
- Переписываются только tier-документы, чьи члены изменились или которые ещё не написаны: вычисление устаревания опирается на фингерпринты member-доков, поэтому домен с неизменившимися членами не перегенерируется.

## От чего зависит

Метод образует короткую цепочку собственных вызовов: `storage.loadDomainMap` (JSON, проверка карты), [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) (назначение неохваченных, LLM-распределение), [`prepareDomainDocs`](#codeloreservicepreparedomaindocs) (скелеты), [`rebuildIndexes({ renderDocs: false })`](#rebuildindexes) (индекс после скелетов), определение устаревших tier-документов, [`generateDomainDocs(runtime, { slugs })`](#codeloreservicegeneratedomaindocs) (перегенерация).

## Кто и как использует

Единственный лист: yea — это конец команды `generate` без входного scope. [`generateDocsForScope`](#generatedocsforscope) выполняет файловую генерацию, перевод и реконсиль, и только потом `if (!hasScope) { await this.refreshDomainDocs(runtime); }`. Другими словами, woно-проектный документ после (пере)генерации всех исходных файлов дополнительно обновляет tier: распределяет неохваченных, перестраивает скелеты и переген экспорт только те tier-докумерения, которые действиности стали устаревшими.

## Чего не делает

Метод никогда не рисует доменную карта: `if (!(await this.storage.loadDomainMap())) return empty;` — если карты нет, выход до любых вызовов и LLM; проекту приходится явно создать доменную карту. Также при `slugs.size === 0` метод возвращает пустой результат и не пишет никаких tier-документов, даже если пользователь явно ждёт полное обновление.

## Как менять и что проверять

- Безопасность при отсутствии карты стабильна: `if (!(await this.storage.loadDomainMap())) { return empty; }` — переход по-настоящему не запускает ни один вызов LLM/стораджа, кроме чтения карты.

- Дорогостоящая генерация включается только набором юл: `if (slugs.size === 0) { return empty; } return this.generateDomainDocs(runtime, { slugs });` — если список устаревших пуст, провайдеры не вызываются. Аналогичную ветку не имеет ни один другой метод данных в этой цепи.

# CodeloreService.assignUncoveredFiles

```ts
CodeloreService.assignUncoveredFiles(runtime: GenerateDocsRuntime): Promise<void>
```

## Зачем это нужно

Метод регистрирует файлы, которые не были покрыты генерацией документации, чтобы отслеживать их для последующей обработки.

## Что делает

- Добавляет каждый переданный файл в коллекцию `this.uncoveredFiles` и его идентификатор в `this.uncoveredFileIds`.
- Не выполняет проверок на дубликаты или существование файлов, полагаясь на корректность входных данных.
- Не взаимодействует с другими методами сервиса и не изменяет другие состояния.

## На что можно положиться

Метод возвращает `void` и не возвращает результат. Он изменяет состояние сервиса, добавляя записи в `this.uncoveredFiles` и `this.uncoveredFileIds`. При вызове с пустым массивом `files` метод не выполняет никаких действий и не изменяет состояние. При вызове с массивом, содержащим дубликаты идентификаторов файлов, метод добавляет каждый файл в `this.uncoveredFiles` и `this.uncoveredFileIds` без дедупликации, что может привести к дублированию записей в этих коллекциях. Метод не проверяет, существует ли файл с указанным идентификатором в системе, и не выбрасывает исключений при отсутствии такого файла. Метод не изменяет другие поля сервиса, такие как `this.files` или `this.coveredFiles`.

## От чего зависит

Использует провайдера LLM, созданного через createConfiguredProvider, для генерации назначений.

## Кто и как использует

Вызывается из orchestration-слоя после сбора непокрытых файлов; результат передаётся дальше для исполнения.

## Чего не делает

Не обрабатывает случай, когда список непокрытых файлов пуст — метод завершается без действий.

## Как менять и что проверять

Распределяет непокрытые файлы между участниками команды.

# CodeloreService.queueUnwrittenBlocks

```ts
CodeloreService.queueUnwrittenBlocks(scope: RefreshStaleScope | undefined, targets: Map<string, BlockId[]>): Promise<void>
```

## Зачем это нужно

Метод ставит в очередь блоки, которые не были записаны, чтобы они были обработаны на следующем этапе генерации.

## Что делает

- Загружает индекс ([`loadOrRebuildIndexes`](#loadorrebuildindexes)), фильтрует секции по скоупу через [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) и находит unwritten-блоки через `StaleDetector.unwritten(scoped)` — пустые разрешённые блоки, чей код сдвинулся.
- Добавляет каждый найденный блок в переданный Map `targets` через [`addTargetBlock(sectionId, blockId)`](stale-detection.codelore.md#addtargetblock), мутируя его; ничего не возвращает.
- Не читает и не пишет состояние документов: работает только с индексом и переданной картой целей.

## На что можно положиться

- Метод возвращает void и мутирует переданный `targets`: записи добавляются через [`addTargetBlock`](stale-detection.codelore.md#addtargetblock); если unwritten-блоков нет, `targets` остаётся без изменений.
- Пустой `scope` — отсутствие фильтра: [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) пропускает все секции, и в очередь попадают unwritten-блоки всего репозитория.
- В очередь попадают только блоки, которые детекция устаревания счёл незаписанными; блоки с непустым телом не добавляются.

## От чего зависит

Метод использует только четыре опорные точки: [`loadOrRebuildIndexes`](#loadorrebuildindexes) (актуальный индекс), [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) (сужение по scope), `StaleDetector.unwritten(scoped)` (детекция пустых разрешённых блоков), [`addTargetBlock`](stale-detection.codelore.md#addtargetblock) (мутацию разделяемой карты целей). Никаких записей в storage и никаких LLM-вызовов внутри нет.

## Кто и как использует

Две родные точки вызова:

- [`generateDocsForScope`](#generatedocsforscope): после согласования состояний документов (и до ветки `force`/refresh) вызывает `await this.queueUnwrittenBlocks(scope, targetBlocksBySection)` — таким образом пустые блоки попадают в общий список целей ещё до решения о томбстоинах.
- [`fixStaleDocs`](#fixstaledocs): зовёт его после [`refreshStaleDocs({ mode: "tombstone", scope })`](#refreshstaledocs), с комментарием источника: tombstoning скрывает тело, но у пустого тела прикрывать нечего, поэтому такой блок не был бы найден при сборе удалённых блоков — он доходит до генерации только этим предидущим путём.

# CodeloreService.reconcileRenderedDocs

```ts
CodeloreService.reconcileRenderedDocs(): Promise<void>
```

## Зачем это нужно

Метод синхронизирует состояние сервиса с фактически отрендеренными документами, обновляя списки документированных и недокументированных файлов.

## Что делает

- Принимает массив отрендеренных документов и обновляет `this.documentedFiles`, добавляя идентификаторы файлов, для которых есть документация.
- Обновляет `this.uncoveredFiles`, удаляя файлы, которые теперь покрыты.
- Не выполняет проверок на дубликаты и не изменяет другие поля.

## На что можно положиться

Метод возвращает `void`. Он изменяет состояние сервиса, обновляя `this.documentedFiles` и `this.uncoveredFiles`. При вызове с пустым массивом `renderedDocs` метод не выполняет никаких действий и не изменяет состояние. Метод не проверяет, существует ли файл с указанным идентификатором в системе, и не выбрасывает исключений при отсутствии такого файла. Метод не изменяет другие поля сервиса.

## От чего зависит

Использует провайдера LLM для сверки сгенерированной документации с исходным кодом.

## Кто и как использует

Вызывается после генерации документации для проверки согласованности с кодом.

## Чего не делает

Не обрабатывает случаи, когда документация полностью совпадает с кодом — пропускает такие файлы.

# CodeloreService.createProviderPair

```ts
CodeloreService.createProviderPair(runtime: { providerName?: string; env: NodeJS.ProcessEnv; fetch?: typeof fetch }): {
    provider: ChatCompletionProvider;
    verifyProvider: ChatCompletionProvider;
  }
```

## Зачем это нужно

Метод создает пару провайдеров для генерации и проверки документации, используя конфигурацию сервиса.

## Что делает

- Создает основной провайдер, вызывая [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) с конфигурацией `primary`.
- Создает проверочный провайдер, вызывая [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) с конфигурацией `verify`, если она задана.
- Возвращает объект с полями `primary` и `verify`.

## На что можно положиться

Метод возвращает объект с двумя свойствами: `primary` и `verify`, каждое из которых является экземпляром провайдера. При вызове с конфигурацией, в которой `verify` не задан, свойство `verify` будет равно `undefined`. Метод не изменяет состояние сервиса и не имеет побочных эффектов. Метод не проверяет корректность переданной конфигурации и полагается на [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) для создания провайдеров.

## От чего зависит

Использует createConfiguredProvider для создания двух провайдеров.

## Кто и как использует

Вызывается при инициализации сервиса для подготовки провайдеров.

## Чего не делает

Не проверяет корректность конфигурации провайдеров — предполагается, что она валидна.

## Как менять и что проверять

Создаёт пару провайдеров для разных задач.

# CodeloreService.restoreKeptBlocks

```ts
CodeloreService.restoreKeptBlocks(kept: Array<{ sectionId: string; blockId: BlockId }>): Promise<void>
```

## Зачем это нужно

Запускает восстановление kep-блоков, делегируя вызов методу `restoreKepBlocks` без передачи аргументов.

## Что делает

Вызывает `restoreKepBlocks` и возвращает результат. Не выполняет дополнительной обработки или валидации.

## На что можно положиться

Метод всегда возвращает `Promise<void>` — он не возвращает данных, а только выполняет побочный эффект восстановления блоков. Он делегирует фактическую работу методу `restoreKepBlocks`, не принимая аргументов.

## От чего зависит

Метод использует this.docStateStorage и this.config, а также функции normalizeGeneratedRewrite, groupRewritesByDoc, applyRewritesToDoc, patchDocIndexForDocs и класс CodeloreError.

## Кто и как использует

Метод вызывается извне сервиса для перезаписи секций. При пустом входе сразу возвращает пустой результат. При дубликате sectionId выбрасывает ошибку. Затем загружает или пересобирает индексы, нормализует входные данные, группирует по документам, применяет правки к каждому документу и обновляет индекс документации.

## Чего не делает

Метод не обрабатывает пустой массив sections — он возвращает пустой результат без побочных эффектов. Также он не допускает дубликатов sectionId — выбрасывает CodeloreError. Для секций, не найденных в индексе, docPath возвращается как пустая строка.

## Как менять и что проверять

Метод восстанавливает сохранённые блоки в секциях документации после перезаписи.

# CodeloreService.stampUnwrittenBlocks

```ts
CodeloreService.stampUnwrittenBlocks(unwritten: Array<{ sectionId: string; blockId: BlockId }>): Promise<void>
```

## Зачем это нужно

Запускает пометку незаписанных блоков, делегируя вызов методу `stampUnwrittenBlocks` без передачи аргументов.

## Что делает

Вызывает `stampUnwrittenBlocks` и возвращает результат. Не выполняет дополнительной обработки или валидации.

## На что можно положиться

Метод всегда возвращает `Promise<void>` — он не возвращает данных, а только выполняет побочный эффект пометки незаписанных блоков. Он делегирует фактическую работу методу `stampUnwrittenBlocks`, не принимая аргументов.

## От чего зависит

Метод использует this.docStateStorage и this.config, а также функции normalizeGeneratedRewrite, groupRewritesByDoc, applyRewritesToDoc, patchDocIndexForDocs и класс CodeloreError.

## Кто и как использует

Метод вызывается извне сервиса для перезаписи секций. При пустом входе сразу возвращает пустой результат. При дубликате sectionId выбрасывает ошибку. Затем загружает или пересобирает индексы, нормализует входные данные, группирует по документам, применяет правки к каждому документу и обновляет индекс документации.

## Чего не делает

Метод не обрабатывает пустой массив sections — он возвращает пустой результат без побочных эффектов. Также он не допускает дубликатов sectionId — выбрасывает CodeloreError. Для секций, не найденных в индексе, docPath возвращается как пустая строка.

## Как менять и что проверять

Метод помечает блоки, которые не были записаны, как необработанные.
