# codelore-service.ts

## Зачем это нужно

The file provides two private methods that both traverse an entity's direct dependencies to produce domain-write data: one yields dependency summaries with optional purpose, the other yields member summaries, each with distinct source resolution rules.

## Что делает

- Собирает в один слой оркестрацию всей документационной системы: класс [`CodeloreService`](#codeloreservice) связывает конфиг, индексы кода и документации, состояние документов на диске и LLM-провайдеров, а хелперы файла (`splitTierSections`, `collectAllowedBlocksForSection`, `resolveTargets`, `scopeFromParts`, `sourceFilePathOf`) задают общие правила, на которых держатся методы класса.
- Разводит генерацию по двум конвейерам с общей границей `splitTierSections`: исходные секции (`file:`/`symbol:`) идут файловым конвейером двумя плоскими фазами — propagating, затем terminal, — а tier-секции (`DOMAIN_ID_PREFIX`/`PROJECT_ID`) — доменным конвейером волнами зависимостей leaves-first.
- Вводит сквозные конвенции фингерпринтов: блоки штампуются [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint), tier-документы — [`domainMemberFingerprint`](../domains/member-evidence.codelore.md#domainmemberfingerprint), документации зависимостей — [`dependencyDocsFingerprint`](../llm/file-pipeline.codelore.md#dependencydocsfingerprint); отклонённые и пустые блоки тоже получают штамп, чтобы последующие прогоны не переспрашивали одно и то же.
- Задаёт единые правила работы с LLM: пару провайдеров writer/verify создаёт [`createProviderPair`](#codeloreservicecreateproviderpair), промпт партиционирования ограничен бюджетом модели через `assertRequestFitsBudget`, невалидный ответ LLM повторяется один раз с описанием ошибки через `appendPartitionRetry`.

## На что можно положиться

Контракты модуля — кодировка идентификаторов, поведение границ входа и правила свертки результатов:
- Идентификаторы сущностей кодируют вид строго: `sourceFilePathOf` возвращает путь только для `file:` и `symbol:` (у `symbol:` обрезает всё после первого `#`), для tier-идентификаторов и `project:` — undefined. На этом же держится `splitTierSections`: префикс `DOMAIN_ID_PREFIX` уводит секцию в tier-конвейер, `PROJECT_ID` — в sentinel-слаг «.» для обзорного документа, всё остальное — в файловый конвейер.
- `resolveTargets` на границе входа: пустой запрос возвращает весь `allowedBlocks`, цель вне разрешённого набора бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `MISSING_BLOCK`; порядок результата всегда канонический, а не порядок запроса — `BLOCK_IDS.filter((id) => requested.includes(id))`.
- `scopeFromParts` с полностью пустыми списками возвращает undefined, а не пустой фильтр; для [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) это означает «все секции репозитория», поэтому вызывающие передают undefined только когда скоупа нет вовсе.
- Секция генерируется обеими фазами и попадает в сводку дважды: `mergeSectionSummaries` схлопывает повторные записи в одну с объединением `generatedBlocks` без дубликатов и `manualReviewNeeded` как OR; `dedupeSkipped` удаляет из skipped секции, которые записала другая фаза.
- Набор переводимых блоков строго ограничен: `translatableBlocks` отдаёт только блоки с `rendered`, без `staleSince` и с `body.trim() !== ""`; перевод актуален только при совпадении `sourceFingerprint` с телом и отсутствии срабатывания [`translationNeedsWork`](../llm/translator.codelore.md#translationneedswork), иначе блок снова попадёт в перевод.

## От чего зависит

Файл подключает всё окружение сервиса: [`loadConfig`](../config.codelore.md#loadconfig) и [`resolveTerms`](../config.codelore.md#resolveterms) (`src/config.ts`) дают конфигурацию и термины для файла/языка; [`JsonStorage`](../storage/json-storage.codelore.md#jsonstorage), [`DocStateStorage`](../storage/doc-state-storage.codelore.md#docstatestorage), [`IndexManager`](index-manager.codelore.md#indexmanager) — состояние на диске, индексы кода и документации. Индекс/граф: [`buildCodeIndex`](../indexer/code-indexer.codelore.md#buildcodeindex), [`parseUnifiedDiff`](../graph/diff.codelore.md#parseunifieddiff), [`buildFileDag`](../graph/file-dag.codelore.md#buildfiledag), [`buildDomainDag`](../graph/domain-dag.codelore.md#builddomaindag), [`dependencyWaves`](../graph/waves.codelore.md#dependencywaves), [`getAffectedSectionsForEntities`](../graph/impact.codelore.md#getaffectedsectionsforentities), [`getImpactForEntity`](../graph/impact.codelore.md#getimpactforentity) и константы/функции `DOMAIN_ID_PREFIX`, `PROJECT_ID`, [`domainIdFor`](../indexer/domain-entities.codelore.md#domainidfor), [`isDomainTierEntity`](../indexer/domain-entities.codelore.md#isdomaintierentity), [`isSourceCodeEntity`](../indexer/domain-entities.codelore.md#issourcecodeentity) дают карту сущностей, рёбер и волн. Доменные чистые функции: [`buildPartitionRequest`](../domains/partition.codelore.md#buildpartitionrequest)/[`parsePartitionResponse`](../domains/partition.codelore.md#parsepartitionresponse), [`buildAssignRequest`](../domains/assign.codelore.md#buildassignrequest)/[`parseAssignResponse`](../domains/assign.codelore.md#parseassignresponse), [`domainCoverage`](../domains/domain-map.codelore.md#domaincoverage)/[`fileToDomainSlug`](../domains/domain-map.codelore.md#filetodomainslug), [`collectDomainMemberEvidence`](../domains/member-evidence.codelore.md#collectdomainmemberevidence)/[`domainMemberFingerprint`](../domains/member-evidence.codelore.md#domainmemberfingerprint) — формирование и разбор LLM-сообщений и отпечатки tier-членов. LLM-слой: [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) (фабрика провайдеров и их бюджет), [`generateFileGroup`](../llm/file-pipeline.codelore.md#generatefilegroup), [`generateDomainDoc`](../llm/domain-pipeline.codelore.md#generatedomaindoc), [`verifyBlocksAgainstDeps`](../llm/file-pipeline.codelore.md#verifyblocksagainstdeps), [`collectDependencyDocs`](../llm/file-pipeline.codelore.md#collectdependencydocs)/[`dependencyDocsFingerprint`](../llm/file-pipeline.codelore.md#dependencydocsfingerprint), [`translateBlocks`](../llm/translator.codelore.md#translateblocks), `writeRunDecisions`. Разметка/состояние: [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint), [`translationSourceFingerprint`](../markdown/block-facets.codelore.md#translationsourcefingerprint), [`docResponsibilities`](../markdown/linkify.codelore.md#docresponsibilities), [`renderSection`](../markdown/render-doc.codelore.md#rendersection), `BLOCK_IDS`/`BlockId`. Внутренние модули той же директории (`prepare-docs`, `section-rewrite`, `stale-detection`/`stale-detector`, `doc-reconcile`, `doc-validation`, `domain-docs`, `file-layout`, `index-manager`, `helpers`) задают правила скоупа, томбстоуны, перезапись, проверки и планы раскладки.

## Чего не делает

В файле действуют три реальные границы:
- Партиционирование умеет только один запрос: `assertRequestFitsBudget` суммирует длины всех `message.content`, делит на `provider.writerBudget.charsPerToken` и при `estimatedTokens > maxPromptTokens` бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `PARTITION_TOO_LARGE`; текст ошибки прямо говорит `Batched partition is not yet implemented`, поэтому набор файлов, не помещающийся в бюджет модели, сейчас разбить нельзя.
- Невалидный ответ LLM переспрашивается ровно один раз: в [`partitionDomainMap`](#codeloreservicepartitiondomainmap) и [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) повторный разбор ([`parsePartitionResponse`](../domains/partition.codelore.md#parsepartitionresponse)/[`parseAssignResponse`](../domains/assign.codelore.md#parseassignresponse)) стоит вне `try`/`catch`, поэтому второй сбой парсинга пробрасывается наверх и останавливает команду без третьей попытки.
- Сбой `git diff` молча глотается: `readGitDiff` в `catch { return ""; }` возвращает пустую строку при любой ошибке `execFile`, и если вызывающий не передал `diff`/`changedFiles`, [`analyzeChange`](#analyzechange) видит пустой diff и не сигнализирует о том, что чтение git не удалось.

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

Контракты класса:
- [`rewriteSections([])`](#rewritesections) возвращает `{ updatedSections: [] }`, не трогая хранилище и индексы; повторный `sectionId` в списке бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `DUPLICATE_SECTION` до первой записи.
- LLM-вызовы идут параллельно, а запись строго последовательна: фаза apply — это поочный цикл по `settled`, и доменные волны тоже `Promise.all` затем применяют документы по одному, потому что [`rewriteSections`](#rewritesections) и [`markReviewNeeded`](#markreviewneeded) мутируют общий doc-индекс; два пишущих прогона в один момент не пересекаются.
- Томбстоун и его откат сходятся: `applyTombstones` пишет блоку `staleSince`, `staleReason`, `staleFacets` и обновляет статус секции; [`restoreKeptBlocks`](#codeloreservicerestorekeptblocks) снимает эти поля и заново штампует `fingerprint`, при этом статус `review_needed` сохраняется; [`stampUnwrittenBlocks`](#codeloreservicestampunwrittenblocks) штампит только блоки с `body.trim() === ""`, чтобы постоянный отказ писателя не перезапрашивал блок в каждом следующем прогоне.
- Read-методы отражают состояние на диске и бросают типизированные ошибки: [`resolveSection`](#resolvesection) — `UNKNOWN_SECTION`, [`requireSectionState`](#requiresectionstate) — `UNKNOWN_DOC`/`UNKNOWN_SECTION`, [`readCodeEntity`](#readcodeentity) — `UNKNOWN_ENTITY`, [`readChange`](#readchange) — `UNKNOWN_CHANGE`; каждый такой метод проходит через [`loadOrRebuildIndexes`](#loadorrebuildindexes) либо прямое чтение состояния/файла.

## От чего зависит

Класс напрямую владеет четырьмя зависимостями: [`loadConfig`](../config.codelore.md#loadconfig) в конструкторе вместо `this.config`, и три объекта хранилища/индексов — [`JsonStorage`](../storage/json-storage.codelore.md#jsonstorage), [`DocStateStorage`](../storage/doc-state-storage.codelore.md#docstatestorage), [`IndexManager`](index-manager.codelore.md#indexmanager). Способ работы одинаков: [`IndexManager`](index-manager.codelore.md#indexmanager) единственный из них принимает из класса коллбек сброса `projectContextCache`. Весь остальной функционал (доменные парсеры, рендер, графы) класс только импортирует и вызывает из методов, не держит его в полях; провайдеры LLM создаются на лету через [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) внутри [`createProviderPair`](#codeloreservicecreateproviderpair). Таким образом внешний мир классу нужен в двух формах: синтаксические LLM-провайдеры (`ChatCompletionProvider`) и объекты `GenerateDocsRuntime` с хуком `onProgress`, которые приходят от CLI/MCP и отдают продвижение выполнения.

## Кто и как использует

Класс обслуживает три внешних контура:
- CLI: [`runCli`](../cli/run-cli.codelore.md#runcli) создаёт ровно один экземпляр на команду (`new CodeloreService(parsed.rootDir)`) и разводит сценарии из `runCommand`: `generate` → [`generateDocsForScope`](#generatedocsforscope), `fix-stale` → [`fixStaleDocs`](#fixstaledocs), `analyze-change` → [`analyzeChange`](#analyzechange), `rebuild-index` → [`rebuildIndex`](#rebuildindex). Результат сериализуется в stdout, а общий `try/catch` в [`runCli`](../cli/run-cli.codelore.md#runcli) переводит вылетевшие ошибки в stderr как `CodeloreErrorPayload`.
- MCP: [`createCodeloreServer`](../server/create-server.codelore.md#createcodeloreserver) поднимает `McpServer` поверх того же экземпляра, поэтому методы класса становятся инструментами для редактора; запускается это через команду `mcp` в [`runCli`](../cli/run-cli.codelore.md#runcli).
- Внешний валидатор: [`verifyBlocksAgainstDeps`](../llm/file-pipeline.codelore.md#verifyblocksagainstdeps) получает экземпляр как параметр `service` и использует из него только `service.config.rootDir` (для `readFile` файла-источника) и `service.config.llm.concurrency` (для своего `pLimit`) — класс выступает для него источником конфигурации, а не хранилища.

## Чего не делает

Действующие границы класса:
- Доменная документация живёт только после явного разбиения: [`refreshDomainDocs`](#codeloreservicerefreshdomaindocs) и бесскоупный [`generateDocsForScope`](#generatedocsforscope) начинают с `if (!(await this.storage.loadDomainMap())) { return empty; }` — пока [`partitionDomainMap`](#codeloreservicepartitiondomainmap) не сохранил карту, обзорный и доменные документы не генерируются вовсе.
- [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) распределяет неохваченные файлы только по существующим доменам: новых доменов она не создаёт (комментарий в коде: `A new domain is never created here — that is a deliberate full re-partition`), это может только полная перепартиционирование через [`partitionDomainMap`](#codeloreservicepartitiondomainmap).
- Перевод дозаполняются лишь для блоков, допущенных генератором `translatableBlocks` (с `rendered`, без `staleSince`, с непустым `body`) — скрытые томбстоунами и пустые блоки перевода не получают.
- Каждый параллельный проход имеет собственный пул `pLimit(this.config.llm.concurrency)` (обе фазы генерации, волны доменов, переводы), поэтому одновременно к модели уходит не أكثر этого значения вызовов.

## Как менять и что проверять

- Инвариант «depDocs-фингепринт записывается только после терминальной фазы» держит код `if (phase === "terminal") { await this.recordDepDocsFingerprints(outcome.writtenSections); }` внутри `applyFileGenerationOutcome`.
- Инвариант «запрошенные цели не попадают в неразрешённое множество» держит `const filtered = requested.filter((blockId) => allowed.has(blockId));` в [`runPipelineForSections`](#runpipelineforsections), а ветка `if (filtered.length === 0) { skipped.push(...); continue; }` превращает опустевшие цели в пропуск, а не в исключение.
- Инвариант «явный провайдер прогона перекрывает дефолтный verify-провайдер» держит тернарник в [`createProviderPair`](#codeloreservicecreateproviderpair): `verifyName && !runtime.providerName ? createConfiguredProvider(this.config, verifyName, providerRuntime) : provider`.

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

Единственная зависимость — вызов `this.indexManager.rebuild`: метод пробрасывает переданный `RebuildIndexesOptions` в `this.indexManager.rebuild(options)` без изменений. Ни состояния, ни конфиг, ни хранилище метод не трогает.

### Кто и как использует

Это общий вход для перестроек в классе. Аналитические пути ([`analyzeChange`](#analyzechange), [`validateDocs`](#validatedocs), [`refreshStaleDocs`](#refreshstaledocs)) вызывают его без параметров, то есть соглашаются на вариант по умолчанию. Пишущие пути — [`prepareInitialDocs`](#prepareinitialdocs), [`prepareDomainDocs`](#codeloreservicepreparedomaindocs), [`partitionDomainMap`](#codeloreservicepartitiondomainmap), [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles), [`generateDomainDocs`](#codeloreservicegeneratedomaindocs), [`refreshDomainDocs`](#codeloreservicerefreshdomaindocs), [`reconcileScopedDocStates`](#codeloreservicereconcilescopeddocstates) — передают фиксированный флаг `{ renderDocs: false }`, потому что свои документы они уже отрендерили и им нужен только обновлённый индекс для последующих чтений и устарелости.

### Чего не делает

Метод перестраивает проект только целиком: из его кода виден лишь `this.indexManager.rebuild(options)`, а сконфренный по скоупу вариант существует отдельным входом — [`prepareInitialDocs`](#prepareinitialdocs) вызывает `this.indexManager.buildScopedIndex(codeIndexScopeFromPrepareScope(scope))`. Частичную перестройку через `rebuildIndexes` получить нельзя.

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

Метод опирается на две сущности: `this.indexManager.rebuild` (с привязанными сюда опциями) и локальный хелпер `summarizeProjectIndex`, который превращает пересобранный индекс в итоговую сводку. Состояние, хранилище и LLM-провайдеры не используются.

### Чего не делает

У метода нет параметров для сохранения: внутрижды зашит строго `this.indexManager.rebuild({ persist: true, renderDocs: true })`, поэтому перестроить индекс «на лету» — без записи на диск и без рендера — здесь не получается. Единственная степень свободы — `input.verbose ?? false`: она лишь добавляет полный `index` в сводку `summarizeProjectIndex`, а счётчики присутствуют всегда.

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

Единственная зависимость — внедрённый менеджер индексов: метод делегирует ему обновление индекса по списку `docPaths` без изменений и больше ничего не вызывает.

### Кто и как использует

Инкрементальное обновление doc-индекса после каждой записи документации, и вызывающие выдают уже сохранённые пути:
- [`rewriteSections`](#rewritesections) — после `applyCoverageToDoc`, передаёт `[...byDoc.keys()]`;
- [`refreshStaleDocs`](#refreshstaledocs) — после применения томбстоунов, передаёт `[...new Set(appliedTombstones.map((entry) => entry.docPath))]`;
- [`markReviewNeeded`](#markreviewneeded) — после `stationedStorage.renderAndPersist(state)`, передаёт `[section.docPath]`;
- [`reconcileRenderedDocs`](#codeloreservicereconcilerendereddocs) — после `docStateStorage.reconcileRenderedDocs()`, передаёт список `updated`.
Во всех случаях вызов идёт до следующего чтения индекса, так что последующие чтения видят свежую doc-часть индекса без полной перестройки.

### Чего не делает

Метод не проверяет корректность набора: он полностью доверяет переданным `docPaths` и передаёт их менеджеру индексов как есть; ответственность за то, что пути действительно записаны в состоянии и на диске, лежит на вызывающих — сам метод не рендерит и не персистит контент.

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

Метод опирается на приватный `this.readProjectContext` (собирает строки из `config.docs.writingRules` через `writingRulesContext`) и на кэш-поле `this.projectContextCache`. Сброс кэша привязан к перестройке индексов: в конструкторе передаётся колбэк `() => { this.projectContextCache = undefined; }`, поэтому каждая перестройка индексов делает кэш недействительным.

### Кто и как использует

Единственный вызывающий — [`getSectionContext`](#getsectioncontext): при `options.includeProjectContext ?? true` метод подставляет результат в поле `projectContext` возвращаемого `SectionContext`, а при `includeProjectContext: false` он вообще не зовётся (`includeProjectContext ? await this.getProjectContext() : undefined`). Так общие правила стиля попадают в контекст, который видят writer и редактор через API инструментов.

### Чего не делает

Кэш хранит ровно одно значение без каких-либо признаков давности: `if (this.projectContextCache) { return this.projectContextCache.value; }` отдаёт сохранённый объект до тех пор, пока колбэк в конструкторе не сбросит поле при перестройке индексов; вторичное чтение `readProjectContext` наступает только этим путём, а не по времени или изменению файла конфига.

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

Вся работа делегируется методу [`rewriteSections`](#rewritesections) этого же класса: метод оборачивает вход в массив `[{ sectionId, ...input }]` и возвращает только первый элемент результата — `result.updatedSections[0]`.

### Чего не делает

Метод перезаписывает ровно одну секцию за вызов: вход оборачивается в массив из одного элемента, и возвращается только `updatedSections[0]`. Для пакетной перезаписи нескольких секций нужно вызывать [`rewriteSections`](#rewritesections) напрямую с полным массивом — этот метод такой возможности не даёт.

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

Список секций получает через `resolveSectionsForId`: для id-секции возвращается `[id]`, для id-сущности — все секции, в чьём `owns` она присутствует, а для неизвестного id выбрасывается ошибка с кодом `UNKNOWN_ENTITY` или `UNKNOWN_SECTION`. Генерацию делегирует [`runPipelineForSections`](#runpipelineforsections) без ограничения целевых блоков — пустая карта `targetBlocksBySection` означает, что генерируются все разрешённые блоки. Переводы обновляет [`translateScope`](#codeloreservicetranslatescope) с областью из `scopeFromParts(sectionIds, [], [])`, которая охватывает только резолвленные секции.

### Чего не делает

Работает только с уже существующими секциями: `resolveSectionsForId` бросает `UNKNOWN_SECTION` для сущности без секции документации и подсказывает создать её через `document` с `entityIds`. Принимает один id за вызов, а переводы обновляются лишь при настроенных `docs.translations` — [`translateScope`](#codeloreservicetranslatescope) выходит раньше, когда список языков пуст.

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

Читает doc-состояние через `this.docStateStorage.loadDocState(docPath)` и пишет его обратно через `this.docStateStorage.renderAndPersist(state)`. Других зависимостей у метода нет.

### Кто и как использует

`applyFileGenerationOutcome` вызывает метод один раз на каждую записанную секцию после применения перезаписей, передавая `runId`, `timestamp`, `command`, имя и модель провайдера и массив `generatedBlocks`; `intent` и флаг `manualReviewNeeded` попадают в запись условно — только когда они заданы. Метод добавляет запись в конец `generationHistory` секции и обновляет `generatedAt` документа.

### Чего не делает

Каждый вызов добавляет ровно одну запись без дедупликации: повторные вызовы с одинаковым `entry` накапливают дубли в `generationHistory`. Метод возвращает `Promise<void>` — факт записи можно проверить, только перечитав состояние.

### Как менять и что проверять

- Запись добавляется копированием массива, а не мутацией прежнего: `sectionState.generationHistory = [...(sectionState.generationHistory ?? []), entry]` — предыдущая история сохраняется, отсутствующая трактуется как пустой массив.
- Пустое состояние не приводит к записи: ранние возвраты `if (!state) { return; }` и `if (!sectionState) { return; }` гарантируют, что вызов для отсутствующего документа или секции не трогает хранилище.

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

Считает отпечаток через `dependencyDocsFingerprint(collectDependencyDocs(index, [file]))` из `../llm/file-pipeline.js` — всегда по одному файлу. Индекс загружает через [`loadOrRebuildIndexes`](#loadorrebuildindexes), секции группирует по `docPath` через [`groupBy`](helpers.codelore.md#groupby) из `./helpers.js`, а состояние читает и пишет через `this.docStateStorage.loadDocState` и `this.docStateStorage.renderAndPersist`.

### Кто и как использует

Вызывается из двух мест. `applyFileGenerationOutcome` вызывает метод после применения перезаписей только в фазе `terminal` (условие `if (phase === "terminal")`), передавая записанные секции, — потому что отпечаток осмыслен лишь после перегенерации терминальных блоков. `gateDepDocsCascade` вызывает метод для секций, которые верификатор подтвердил согласованными с новыми dependency-доками (`verifiedClean.has(target.sectionId)`), чтобы освежить их отпечаток и исключить из последующего tombstone-прохода.

### Чего не делает

Владелец секции берётся только по первому элементу `owns[0]`: для секции с несколькими owned-сущностями отпечаток dependency-доков вычисляется по файлу первой сущности, остальные владельцы не учитываются.

### Как менять и что проверять

- Отпечаток вычисляется один раз на файл и переиспользуется между секциями одного документа: `let fingerprint = fingerprintByFile.get(file); if (fingerprint === undefined) { ... fingerprintByFile.set(file, fingerprint); }` — секции одного файла делят один вызов [`dependencyDocsFingerprint`](../llm/file-pipeline.codelore.md#dependencydocsfingerprint).
- Документ персистится только при реальном изменении: `if (mutated) { await this.docStateStorage.renderAndPersist(state); }` — вызов, где ни одна секция не прошла фильтры, ничего не пишет в хранилище.

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

Загружает индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes). Для неизвестного id бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_ENTITY` и деталями `{ entityId }` (класс из `../errors.ts`). Код сущности получает делегированием в `readEntityCode`, который читает файл `join(this.config.rootDir, entity.path)` и возвращает срез от `entity.range.startOffset` до `entity.range.endOffset`.

### Чего не делает

Возвращает только фрагмент исходника в границах сущности: `readEntityCode` срезает прочитанный файл от `entity.range.startOffset` до `entity.range.endOffset`, поэтому код вне диапазона `entity.range` в результат не попадает.

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

Загружает актуальный индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes) и полностью делегирует вычисление [`getImpactForEntity(index.code, index.docs, entityId)`](../graph/impact.codelore.md#getimpactforentity) из `../graph/impact.js`, передавая индекс кода, индекс документации и id сущности. Собственной обработки результата метод не выполняет.

### Чего не делает

Метод принимает один `entityId` за вызов — пакетного запроса воздействия по нескольким сущностям нет. Валидации id в методе нет: результат для неизвестного id целиком определяется поведением [`getImpactForEntity`](../graph/impact.codelore.md#getimpactforentity), метод не добавляет собственных проверок или ошибок.

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

Собственных компонентов сервиса не использует: файл читает импортированный из `node:fs/promises` `readFile`, путь собирает `join` из `node:path`, а корень проекта берёт из `this.config.rootDir` (конфигурация подгружена в конструкторе). Индексы, doc-state-хранилище и методы рендеринга в вызове не участвуют.

### Чего не делает

The method only renders sections that have a non-empty state; sections without a state are skipped. The early return in resolveSection when the section is not found prevents any rendering for unknown sections.

### Как менять и что проверять

- Путь всегда привязан к корню проекта через конструкцию `join(this.config.rootDir, docPath)`, поэтому чтение идёт только из репозитория, а не из index-кэша или state-хранилища.
- Кодировка закошена вторым аргументом вызова — `"utf8"` в `readFile(join(this.config.rootDir, docPath), "utf8")`, содержимое всегда декодируется как UTF-8.

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

Зависит от состояния индекса: метод вызывает `this.loadOrRebuildIndexes()` (загрузка кэша или пересборка) и из полученного `ProjectIndex` обращается к `index.docs.sections[sectionId]`. Ошибку `UNKNOWN_SECTION` строит из [`CodeloreError`](../errors.codelore.md#codeloreerror) с `src/errors.ts`; других модулей в lookup не участвует.

### Кто и как использует

Все три видимых вызова — [`getSectionContext`](#getsectioncontext), [`markReviewNeeded`](#markreviewneeded) и [`readDocSection`](#readdocsection) — начинаются с этого метода. [`getSectionContext`](#getsectioncontext) сразу разворачивает пару «index, section» в `section.owns/depends/docPath` и сущности `index.code`; [`markReviewNeeded`](#markreviewneeded) и [`readDocSection`](#readdocsection) из `section.docPath` и `sectionId` идут дальше к состоянию секции. Брошенный здесь [`CodeloreError`](../errors.codelore.md#codeloreerror) всплывает до любой записи: например, [`markReviewNeeded`](#markreviewneeded) не выставит `review_needed` секции, отсутствующей в индексе, — сбой виден раньше, чем начнётся правка состояния.

### Чего не делает

Узнаёт только секции, которые уже есть в `index.docs.sections`; для сущности, у которой секции нет (или она выпала из индекса), возвращается ошибка `UNKNOWN_SECTION`, а не заглушка. Подмену «id сущности → id секции» метод не делает — lookup строго по `sectionId`.

### Как менять и что проверять

- Гервент «секция обязана существовать» закреплён `if (!section) { throw new CodeloreError("UNKNOWN_SECTION", ...) }` — после метода ни один вызывающий не получит `undefined`-секцию.
- Lookup всегда по свежему снимку: `const index = await this.loadOrRebuildIndexes();` стоит перед обращением к `index.docs.sections[sectionId]`.

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

Читает состояние через `this.docStateStorage.loadDocState(docPath)` (хранилище из конструкции сервиса), которое возвращает `undefined` при отсутствующем файле состояния. Обе ошибки кодирует [`CodeloreError`](../errors.codelore.md#codeloreerror) из `src/errors.ts`: `UNKNOWN_DOC` для отсутствующего состояния и `UNKNOWN_SECTION` для отсутствия секции внутри него.

### Кто и как использует

Callers invoke this method when they need to read or mutate a section's blocks. The method either returns the section's state and section object, or rejects with a typed error, so callers can proceed without additional existence checks. The returned `state` is the `DocState` that owns the section, enabling mutation through it.

### Чего не делает

Метод никогда не создаёт отсутствующее состояние: `UNKNOWN_DOC` (когда хранилище вернуло `undefined`) и `UNKNOWN_SECTION` (когда секции нет в загруженном состоянии) — это fail-fast исход, а не приглашение инициализировать пустое состояние или секцию-заглушку. Возвращаемый `state` — пришедший из хранилища объект, через который вызывающий может мутацировать секцию, но сам метод никаких изменений не вносит.

### Как менять и что проверять

- Двухуровневая проверка отсутствия: `if (!state)` бросает `UNKNOWN_DOC`, `if (!sectionState)` бросает `UNKNOWN_SECTION` — секция не может быть возвращена без файла состояния, а файл без секции.
- Секция всегда берётся из того же состояния, что и отдаётся: `const sectionState = state.sections[sectionId]` читает из того же `state`, который затем попадёт в результат.

# CodeloreService.translateScope

```ts
CodeloreService.translateScope(scope: RefreshStaleScope | undefined, runtime: GenerateDocsRuntime): Promise<void>
```

## Зачем это нужно

The method exists to produce translated documentation for a scope, which is a collection of entities, by translating each entity individually and aggregating the results.

## Что делает

The method filters sections by scope, groups by docPath, collects source paths, creates a provider, and calls translateDoc per docPath with concurrency limit. It returns Promise<void>.

## На что можно положиться

Границы работы метода:
- Переводы не настроены (`config.docs.translations.length === 0`) — метод выходит до загрузки индекса и создания провайдера; то же происходит, когда после фильтрации по скоупу `docPaths` пуст.
- Скоуп `undefined` означает «весь репозиторий», а не «ничего»: [`filterSectionsByScope`](stale-detection.codelore.md#filtersectionsbyscope) без фильтра пропускает все секции, так что `translateScope(undefined)` добирается и до уже свежих документов — это и есть механизм дозаполнения переводов для только что добавленного языка.
- Источники терминов собираются по `section.owns[0]`: если первый владелец секции не имеет пути в индексе, секция пропускается; путь попадает в `sourcePathsByDoc` без дублей.
- Документы переводятся параллельно под `pLimit(this.config.llm.concurrency)`, и сам метод ничего не пишет: запись выполняет только `translateDoc`, и только если что-то изменилось.

## От чего зависит

Зависит от `runPipelineForSection` для обработки секций и от `pLimit` для ограничения числа параллельных операций.

## Кто и как использует

Три сценария генерации зовут метод после того, как текст новых блоков уже записан: [`generateDocsForEntity`](#generatedocsforentity) — с скоупом `scopeFromParts(sectionIds, [], [])` по секциям сгенерированного объекта; [`generateDocsForScope`](#generatedocsforscope) — со скоупом из путей/файлов/сущностей запроса (а при документировании без скоупа — `undefined`, что включает и документы вне списка изменённого); [`fixStaleDocs`](#fixstaledocs) — со скоупом `input.sectionIds/files/paths` сразу после пайплайна, до регенерации тир-доков. Внутри `translateDoc` пропускает блоки, перевод которых актуален (проверка `isCurrent`), поэтому повторный вызов с тем же скоупом после уже выполненного перевода не порождает новых LLM-запросов.

## Чего не делает

Без настроенных языков метод не стартует совсем: `if (this.config.docs.translations.length === 0) { return; }` стоит до загрузки индекса и создания провайдера, а второй ранний выход — `if (docPaths.length === 0) { return; }` — отсекает пустой результат фильтрации до вызова LLM. Термины для переводчика собираются только из секций, первый владелец которой имеет путь в `index.code` (`if (!ownerPath) { continue; }`); секции без пути источник терминов своему документу не дают, сам документ всё равно переводится с пустым локальным списком путей.

## Как менять и что проверять

- Ранний выход без конфигурации закреплён guard'ом `if (this.config.docs.translations.length === 0) { return; }`, который выполняется раньше [`loadOrRebuildIndexes`](#loadorrebuildindexes) и [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider).
- Параллельные вызовы переводов ограничены: `const limit = pLimit(this.config.llm.concurrency);` — каждый документ уходит в работу через `limit(() => this.translateDoc(...))`, поэтому одновременные LLM-вызовы не превышают `llm.concurrency`.

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

Инварианты работы метода:
- Нет документированных файлов — [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `NO_DOCUMENTED_FILES` бросается до создания провайдера и первого LLM-вызова.
- В запрос на разбиение попадают только рёбра файлового DAG, у которых оба конца документированы: недокументированный источник или цель отсекается условиями `if (!knownFiles.has(from))` и `if (!knownFiles.has(to))`, поэтому граф вне документированного набора не влияет на разбиение.
- На невалидный ответ LLM (`INVALID_LLM_RESPONSE`) метод переспрашивает ровно один раз через `appendPartitionRetry` — в сообщения добавляются предыдущий `assistant`-текст и `user`-просьба вернуть исправленный JSON; повторный parse стоит вне `try`, поэтому второй сбой прокидывает ошибку наверх без повторной подачи.
- Успешный результат сразу сохраняется `storage.saveDomainMap(map)`, а возвращаемое число файлов — это `knownFiles.size`, то есть число отправленных на разбиение документированных файлов.

## Чего не делает

Разбиение не умеет дробиться на части: весь набор файлов и рёбер уходит в один запрос, и перед первым (и единственным) вызовом провайдера `assertRequestFitsBudget` проверяет оценку токенов — при `estimatedTokens > maxPromptTokens` метод бросает [`CodeloreError("PARTITION_TOO_LARGE", ...)`](../errors.codelore.md#codeloreerror) с текстом, что батчинга ещё нет, так что крупный проект, не влезающий в контекст, остаётся неразбитым без автоматической запасной стратегии. Входными считаются только документированные файлы: все рёбра графа, у которых хотя бы один конец (источник или цель) вне `knownFiles`, отбрасываются до построения запроса, поэтому недокументированные части проекта в разбиение не попадают.

## Как менять и что проверять

- Провайдер не вызывается на пустом наборе: guard `if (files.length === 0) { throw new CodeloreError("NO_DOCUMENTED_FILES", ...) }` останавливает алгоритм до создания конфигурации провайдера.
- Запрос не уходит с превышением контекста: `assertRequestFitsBudget(request, provider)` (внутренняя проверка `if (estimatedTokens > maxPromptTokens)`) срабатывает перед `provider.complete(request)`.

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

- [`refreshDomainDocs`](#codeloreservicerefreshdomaindocs) вызывает этот метод как последний этап автоматического обновления тира: сначала подготовительные шаги и [`prepareDomainDocs`](#codeloreservicepreparedomaindocs), затем список слагов тиров, и результат `{ generated, droppedBlocks, failed }` возвращается наружу без постобработки.
- [`fixStaleDocs`](#fixstaledocs) обращается к методу только когда выделены tier-секции (`domain:<slug>` или `project:`), передаёт `slugs` тиров; возвращённые `failed` и счётчики `generated`/`droppedBlocks` метод заворачивает в запись запуска, поэтому лог запуска показывает работу тира даже когда файловый пайплайн ничего не написал.
- Оба вызывающих опираются на то, что волны идут листьями вперёд: [`fixStaleDocs`](#fixstaledocs) обращается к summary зависимых доменов уже после того, как предыдущая волна записала их прозу, поэтому генератор зависимого тира не дёргает провайдер повторно за их содержимым.

## Чего не делает

- Работает только при сохранённой карте доменов: `if (!map) throw new CodeloreError("NO_DOMAIN_MAP", ...)` срабатывает до всех обращений к провайдеру, поэтому прямой вызов до построения карты падает исключением; [`refreshDomainDocs`](#codeloreservicerefreshdomaindocs) заранее проверяет наличие карты и не вызывает метод без неё.
- Упавший тир не ретраится в этом прогоне: `catch (error)` фиксирует `failed.push({slug: entity.path, ...})` и возвращает `answered: false` — такие блоки не включаются в `unsettled`, и домен перегенеряется в следующий запуск (скелет остаётся на диске).
- Генерация тиров внутри волны параллельна (`Promise.all` + pLimit), но запись результатов — строго последовательный цикл `for (const { entity, blocks, dropped, answered } of results)`: комментарий в коде требует сериальной персистенции, потому что запись держит общий контекст рендера.

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

- Перебирает состояния через `this.docStateStorage.listDocStates()` и `this.docStateStorage.loadDocState(docPath)`.
- Извлекает lead из состояния через [`docResponsibilities(state)`](../markdown/linkify.codelore.md#docresponsibilities) из `src/markdown/linkify.ts`; документ без non-empty lead пропускается (`if (!lead) continue`).
- Путь файла получает через локальный `sourceFilePathOf(entityId)` — ids вида `file:...` отдаёт путь напрямую, `symbol:...#` обрезает до `#`; остальные ids (доменные, проектные) возвращают `undefined` и отбрасываются.
- Фильтрует результат по входящему индексу кода через `index.code.fileToEntities[filePath]`.

## Кто и как использует

- [`partitionDomainMap`](#codeloreservicepartitiondomainmap) первым делом зовёт метод и, если `files.length === 0`, решает что делить нечего и бросает `NO_DOCUMENTED_FILES`; из полученных путей строится `knownFiles` и рёбра DAG для запроса разбиения.
- [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) затем для каждого пути подставляет текст lead: файл, уже описанный файлом-доком, отправится с текстом lead в запрос к LLM, файл без lead — с пустой строкой.
- `detectUncoveredFiles` использует список путей как источник для определения непокрытых файлов: непокрытые файлы становятся предупреждениями с кодом `uncovered_file` результата валидации.

## Чего не делает

- «Первый выигрывает» для каждого файла: запись в `Map` ставится только по `!leadByFile.has(filePath)`, поэтому после первого встреченного состояния lead файла больше не меняется — какой из секций одного файла даст lead, определяется порядком `state.sectionOrder`.
- В результат не попадают файлы, отсутствующие в индексе кода: guard `filePath && index.code.fileToEntities[filePath]` отбрасывает их, даже если они числятся в состоянии дока.
- Результат не включает тир-секции (domain/project): `sourceFilePathOf` не возвращает для них путь, поэтому такие докумен теряются из списка целиком.

## Как менять и что проверять

- Одна запись на файл держится через `!leadByFile.has(filePath)` — изменение «первый выигрывает» возможно только отменив эту проверку.
- Сортировка рабочего результата задана `.sort((a, b) => a.path.localeCompare(b.path))` — пути выходят в лексикографическом порядке независимо от порядка обхода.
- Фильтр «документированного индекса» стоит в `filePath && index.code.fileToEntities[filePath]` — убрав эту проверку, в список попадут файлы, которых нет в кодовой стороне индекса.

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

- Считывает и сохраняет карту доменов через storage.
- Отыскивает непокрытые файлы через [`domainCoverage(map, paths)`](../domains/domain-map.codelore.md#domaincoverage) из `src/domains/domain-map.ts` на основе результата [`collectDocumentedFileLeads`](#codeloreservicecollectdocumentedfileleads).
- Строит запрос [`buildAssignRequest`](../domains/assign.codelore.md#buildassignrequest) и разбирает ответ [`parseAssignResponse`](../domains/assign.codelore.md#parseassignresponse) из `src/domains/assign.ts`.
- Провайдер для единственного LLM-вызова берёт из `createProviderPair(runtime).verifyProvider`, а исключения фильтрует по коду `INVALID_LLM_RESPONSE` из [`src/errors.ts`](../errors.codelore.md).

## Кто и как использует

- [`fixStaleDocs`](#fixstaledocs) вызывает метод самым первым с прогресс-строкой «assigning uncovered files and rebuilding tier skeletons»: комментарий поясняет, что раз присваивание записано на диск до расчёта stale, последующая проверка stale в том же запуске заметит смену индексированного членства и перегенерирует принимающий домен, не отлавливая его спустя запуск.
- [`refreshDomainDocs`](#codeloreservicerefreshdomaindocs) зовёт метод перед генерацией доменов: получивший файлы домен становится stale из-за смены membership, и последующий расчёт tier-слагов подхватит его для генерации.
- Метод меняет только карту: сохраняет её с обновлённым `generatedAt`, а создание новых доменов оставляет отдельному шагу — в этом методе их никогда нет.

## Чего не делает

- Новых доменов метод не создаёт: `map.domains` остаётся исходным — это только распределение по существующим; создание новой границы домена — отдельный шаг (комментарий «A new domain is never created here»).
- Ретрай выполнен ровно один: при `INVALID_LLM_RESPONSE` добавляется feedback-сообщение и второй `complete`, но повторный [`parseAssignResponse`](../domains/assign.codelore.md#parseassignresponse) стоит уже вне try, так что вторая невалидность пробрасывается наружу.
- При отсутствии `uncovered` или карты метод делает ранний выход без вызовов LLM — это no-op для скоупа, где неприкрытых файлов нет.

## Как менять и что проверять

- В файл домена путь попадает не более одного раза: `if (domain && !domain.files.includes(file))` перед добавлением.
- Список `domain.files` в карте сразу приводится к сортированному виду выражением `domain.files = [...domain.files, file].sort()`.
- Ретрай ограничен одним: первый parse внутри try, второй [`parseAssignResponse(retryCompletion.content, knownFiles, knownSlugs)`](../domains/assign.codelore.md#parseassignresponse) — уже за пределами try, поэтому вторая неудача не имеет защитной ветки.

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

- Делегирует перерисовку `this.docStateStorage.reconcileRenderedDocs()` — источник перечня `updated`.
- Если перечень непуст, обновляет индекс пачт-каналом через собственный [`patchDocIndexForDocs(updated)`](#patchdocindexfordocs) (тот дергает `indexManager.patchDocs`).

## Кто и как использует

- [`prepareDomainDocs`](#codeloreservicepreparedomaindocs) вызывает его в конце после сохранения скелетов и пересборки индекса; [`generateDomainDocs`](#codeloreservicegeneratedomaindocs) — после последней пересборки и stamping-подписей;
- [`fixStaleDocs`](#fixstaledocs) — после файлового пайплайна и тир-генерации, и перед финальной проверкой каскада зависимых доков;
- [`generateDocsForScope`](#generatedocsforscope) — после файлового пайплайна и перевода скоупа, но прежде общего обновления доменов.
- Общий паттерн вызова: каждый из этих методов ставит его в конец своего прохода, чтобы доки, созданные в поздних шагах, имели финальный .md раньше, чем патчится индекс: рано перерисованный док ещё не видит зависимых доков этого же прогона.

## Чего не делает

- У метода нет параметров, поэтому ограниченая выборочная пере-присота невозможна: он всегда спрашивает весь `docStateStorage` целиком (`reconcileRenderedDocs(): Promise<void>` без аргументов), и вызвающий не может исключить из обработки один док.
- Патч индекса выполняется только когда перерисование действительно что-то вернуло: `if (updated.length > 0)` — при полностью свежем состоянии метод не трогает индекс, а принудительной пере-генерации здесь не предусмотрено.

# CodeloreService.createProviderPair

```ts
CodeloreService.createProviderPair(runtime: {
    providerName?: string;
    env: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    onProgress?: (message: string) => void;
  }): {
    provider: ChatCompletionProvider;
    verifyProvider: ChatCompletionProvider;
  }
```

## Зачем это нужно

Даёт вызывающим два провайдера — писателя и верификатора — так, чтобы факт-чекинг уходил на отдельный, обычно более дешёвый провайдер из конфигурации, а принудительный `runtime.providerName` отменял это расщепление и использовал одну модель для всего.

## Что делает

- Создаёт писателя `provider` через [`createConfiguredProvider`](../llm/provider.codelore.md#createconfiguredprovider) с именем `runtime.providerName` и общим `providerRuntime` из `env`, `fetch` и `callReporter(runtime.onProgress)`.
- Заводит верификатор отдельным экземпляром только при `config.llm.verifyProvider` и при отсутствии `runtime.providerName`; во всех остальных случаях `verifyProvider` — это тот же объект, что и `provider`.
- Подключает телеметрию `onCall` к обоим провайдерам: репортер превращает длительность, объём промпта, токены вывода и ошибку вызова в одну progress-строку.

## На что можно положиться

- При заданном `runtime.providerName` возвращается один экземпляр: условие `verifyName && !runtime.providerName` не выполняется, и `verifyProvider` присваивается ровно тот же `provider`.
- При отсутствии `runtime.providerName` и заданном `config.llm.verifyProvider` возвращаются два разных экземпляра — только в этой комбинации пара может различаться.
- Метод ничего не пишет: не трогает конфиг, хранилище или индексы, а только собирает провайдеры из переданного рантайма и конфигурации, поэтому повторный вызов даёт параллельные независимые объекты.

## От чего зависит

Использует createConfiguredProvider для создания двух провайдеров.

## Кто и как использует

- [`runPipelineForSections`](#runpipelineforsections) получает пару в начале и передаёт оба провайдера в обработку файловых групп на фазы `propagating` и `terminal` — writer генерирует текст, verify-провайдер проверяет факты на каждой фазе.
- [`generateDomainDocs`](#codeloreservicegeneratedomaindocs) отдаёт пару в генерацию тир-доков: writer пишет раздел тира, verify-провайдер сверяет блоки против member evidence.
- [`assignUncoveredFiles`](#codeloreserviceassignuncoveredfiles) и `gateDepDocsCascade` берут только `verifyProvider` — один «дешёвый» LLM-вызов для классификации файла в домен и для чистого факт-чека против dependency docs (комментарий кода: picking a domain from a fixed list is classification, не phase-переход).
- Прогресс-репортер подключается ко всем созданным инстансам через один `callReporter(runtime.onProgress)` в общем `providerRuntime`.

## Чего не делает

- При заданном `runtime.providerName` полностью выключен отдельный verify: условие `verifyName && !runtime.providerName` ложно, `verifyProvider` становится тем же объектом, что и в ролях, поэтому «дешёвый» факт-чек силами `thin` модели в этом режиме недоступен.
- Без `onProgress` у рантайма канал телемерии отключается целиком: `callReporter(runtime.onProgress)` при undefined возвращает `{}` (`if (!onProgress) return {}`), и ни один провайдер не получит `onCall`.

## Как менять и что проверять

- Условие «разделять только без принудительного провайдера» заковано в выражении `verifyName && !runtime.providerName ? createConfiguredProvider(this.config, verifyName, providerRuntime) : provider`.
- Тот же runtime-богат: `const providerRuntime = { env: runtime.env, fetch: runtime.fetch, ...callReporter(runtime.onTwelve) }` — `env`, `fetch` и репортер прокидываются в любой созданный экземпляр единым объектом.

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

- Группирует входные записи по док-путям через [`groupBy`](helpers.codelore.md#groupby) из `src/service/helpers.ts`.
- Путь для записи ищет в текущем индексе: `index.docs.sections[entry.sectionId]?.docPath` после [`loadOrRebuildIndexes()`](#loadorrebuildindexes).
- Вычисляет свежий отпечаток блока по коду через [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) из `src/markdown/block-facets.ts`.
- Читает и пишет состояния через storage состояний.

## Кто и как использует

- `applyFileGenerationOutcome` вызывает метод после того, как для каждого kept-блока выставил `review_needed`, а затем ещё отмечает незаписанные блоки: сохранённый текст возвращается на экран, но секция остаётся отмеченной — «может быть устаревшим» живёт именно здесь.
- [`generateDomainDocs`](#codeloreservicegeneratedomaindocs) собирает `unsettled` — блоки, по которым writer ответил в волне, но текст не пришлось на место (включая «ничего»), — и после одной волны вызывает `restoreKeptBlocks(unsettled)` и отмечает незаписанные блоки.
- Оба вызова опираются на то, что tombstone поднялся в том же запуске: ответ writer-отказ означает отложенный retain, а текст берётся из state, где он до сих пор лежит.

## Чего не делает

- Блоки без поднятого tombstone игнорируются: guard `!sectionState || !block || block.staleSince === undefined` переводит такой запрос в `continue` — повторная передача уже распакованного блока ничего не делает.
- Записи ба без документа в текущем индексе отсекаются до работы: `.filter((entry) => entry.docPath !== "")` — если `index.docs.sections` не знает sectionId, пара не будет перерисовываться.
- Свежий fingerprint записывается только если его удалось вычислить: `if (fingerprint !== undefined) { block.fingerprint = fingerprint; }` — stale-флаги снимутся и без него, но отпечаток может остаться старым.

## Как менять и что проверять

- Тройное очищение stale-свойств в одном месте: `block.staleSince = undefined; block.staleReason = undefined; block.staleFacets = undefined;`.
- Состояние перерисовывается один раз на док за вызов: `let mutated = false` + `if (mutated) { await this.docStateStorage.renderAndPersist(state); }` — объединяет записи многих блоков одного doc в один рендер.
- Отсутствующее в индексе закрывается фильтром `entry.docPath !== ""` до группировки — тихий cherry-pick для tier-секций, у которых в этот прогон нет пути.

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

## Кто и как использует

Метод вызывается из `applyFileGenerationOutcome` и из [`generateDomainDocs`](#codeloreservicegeneratedomaindocs) (в конце обработки волны для `unsettled`) — оба передают массив блоков, которые писатель отказался записывать. Метод загружает индекс, сопоставляет каждую запись с docPath, группирует по документам, для каждого блока с пустым телом вычисляет отпечаток и записывает его в состояние, затем рендерит и сохраняет изменённый документ. Благодаря этому на следующем запуске сохранённый отпечаток позволяет не запрашивать блок повторно, пока не изменится документируемый код.

## Чего не делает

Метод обрабатывает только блоки с пустым телом: блоки с непустым `body.trim()` пропускаются. Если [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) возвращает `undefined`, блок остаётся без отпечатка. Если для документа нет сохранённого состояния, метод пропускает весь документ. Записи без определённого `docPath` (пустая строка) отфильтровываются до группировки.

## Как менять и что проверять

- Инвариант: пустой блок получает отпечаток только если его тело пусто; конструкция `block.body.trim() !== ""` в условии `if (!sectionState || !block || block.body.trim() !== "")`.
- Инвариант: блок без вычислимого отпечатка не штампуется; конструкция `if (fingerprint === undefined) { continue; }`.
- Инвариант: пустой список записей завершает метод без побочных эффектов; конструкция `if (unwritten.length === 0) { return; }`.
