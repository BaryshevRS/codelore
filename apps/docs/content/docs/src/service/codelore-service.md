---
title: CodeloreService
---

## Зачем это нужно

Обеспечивает единую точку входа для всех операций Codelore: управление индексами, генерация и обновление документации, анализ изменений и валидация.

## Что делает

* Делегирует построение и загрузку индексов [`IndexManager`](/docs/src/service/index-manager#indexmanager), а персистентность — [`JsonStorage`](/docs/src/storage/json-storage#jsonstorage) и [`DocStateStorage`](/docs/src/storage/doc-state-storage#docstatestorage).
* Оркестрирует полный жизненный цикл документации: подготовку скелетов ([`prepareInitialDocs`](#prepareinitialdocs)), обнаружение устаревших блоков ([`refreshStaleDocs`](#refreshstaledocs)), вызов LLM через [`runPipelineForSections`](#runpipelineforsections) и применение результатов ([`rewriteSections`](#rewritesections)).
* Предоставляет методы только для чтения ([`readDocSection`](#readdocsection), [`readCodeEntity`](#readcodeentity), [`readImpact`](#readimpact), [`readChange`](#readchange), [`readDocFile`](#readdocfile)) и валидации ([`validateDocs`](#validatedocs)).
* Кэширует проектный контекст (`projectContextCache`) и сбрасывает его при перестроении индекса через колбэк в [`IndexManager`](/docs/src/service/index-manager#indexmanager).

## rebuildIndexes

### Зачем это нужно

Предоставляет возможность принудительно перестроить проектный индекс с опциями персистентности и рендеринга документации.

### Что делает

* Принимает опциональные флаги `persist` и `renderDocs`, которые передаются без изменений.

### На что можно положиться

* Возвращает `ProjectIndex` — гарантированно не `undefined`.

## rebuildIndex

### Зачем это нужно

Предоставляет высокоуровневый интерфейс для перестроения индекса с автоматической персистентностью и рендерингом, возвращая сводку результата.

### Что делает

* Оборачивает результат в `RebuildIndexResult` через функцию `summarizeProjectIndex`, опционально включая полный индекс при `input.verbose === true`.

### На что можно положиться

* Всегда возвращает `{ ok: true }` — метод не бросает исключений при нормальной работе.

## patchDocIndexForDocs

### Зачем это нужно

Обновляет индекс документации для указанных файлов без полного перестроения проектного индекса.

### Что делает

* Не выполняет никакой дополнительной обработки или валидации переданных путей.

### На что можно положиться

* Не бросает исключений при пустом массиве `docPaths`.

## loadOrRebuildIndexes

### Зачем это нужно

Предоставляет ленивую загрузку проектного индекса с автоматическим перестроением при отсутствии кэша.

### Что делает

* Загружает или перестраивает индекс и возвращает результат без постобработки.

### На что можно положиться

* Всегда возвращает `ProjectIndex` — гарантированно не `undefined`.

## analyzeChange

### Зачем это нужно

Анализирует изменения в коде (из diff или списка файлов) и определяет затронутые сущности и секции документации.

### Что делает

* При отсутствии `input.diff` и `input.changedFiles` читает git-diff через `readGitDiff`.
* Определяет изменённые сущности: по diff через `changedEntitiesFromDiff`, по списку файлов через `changedEntitiesFromFiles`.
* Вычисляет затронутые секции через [`getAffectedSectionsForEntities`](/docs/src/graph/impact#getaffectedsectionsforentities) и сохраняет результат.
* Не модифицирует индексы или состояние документации.

### На что можно положиться

* При пустом `input` и отсутствии git-diff возвращает анализ с пустыми `changedFiles`, `changedEntities` и `affectedSections`.

## getAffectedSections

### Зачем это нужно

Предоставить интерфейс для получения списка секций документации, затронутых заданным набором идентификаторов сущностей.

### Что делает

Загружает актуальный индекс проекта через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
Делегирует вычисление [`getAffectedSectionsForEntities`](/docs/src/graph/impact#getaffectedsectionsforentities) из `src/graph/impact.ts`.
Возвращает массив `AffectedSection` без побочных эффектов.

### На что можно положиться

Возвращает пустой массив, если ни одна секция не затронута.
Не изменяет состояние хранилища.

## prepareInitialDocs

### Зачем это нужно

Создать начальное состояние документации для сущностей, у которых ещё нет секций, сохраняя скелетные секции в хранилище.

### Что делает

Нормализует входной скоуп через [`normalizePrepareScope`](/docs/src/service/prepare-docs#normalizepreparescope).
Для каждой сущности, которая должна иметь страницу и не имеет секции, создаёт `DocStateSection` через [`docStateSectionForPlannedEntity`](/docs/src/service/prepare-docs#docstatesectionforplannedentity).
Использует [`planFileLayout`](/docs/src/service/file-layout#planfilelayout) для группировки сущностей по файлам.
Возвращает результат через [`preparedDocsResult`](/docs/src/service/prepare-docs#prepareddocsresult).

### На что можно положиться

При `dryRun: true` не выполняет запись в хранилище.
Выбрасывает ошибку, если любой из `entityIds` отсутствует в индексе.

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
Нормализует каждую перезапись через [`normalizeGeneratedRewrite`](/docs/src/service/section-rewrite#normalizegeneratedrewrite).
Группирует перезаписи по doc-файлу через [`groupRewritesByDoc`](/docs/src/service/section-rewrite#grouprewritesbydoc).
Для каждого doc-файла вызывает [`applyRewritesToDoc`](/docs/src/service/section-rewrite#applyrewritestodoc), который обновляет `DocState` в хранилище.
После применения всех перезаписей обновляет doc-индекс через [`patchDocIndexForDocs`](#patchdocindexfordocs).
Собирает отфильтрованные блоки для каждой секции и возвращает их.

### На что можно положиться

Выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `DUPLICATE_SECTION`, если один и тот же `sectionId` встречается в массиве `sections` более одного раза.
Возвращаемый массив содержит ровно одну запись на каждый входной элемент в том же порядке.
doc-индекс обновляется только после успешного применения всех перезаписей.

## markReviewNeeded

### Зачем это нужно

Позволяет пометить секцию документации как требующую ручной проверки после обнаружения проблем при генерации.

### Что делает

* Разрешает секцию и её состояние через [`resolveSection`](#resolvesection) и [`requireSectionState`](#requiresectionstate).
* Устанавливает статус `"review_needed"`, обновляет `generatedAt` и персистирует состояние через `docStateStorage.renderAndPersist`.
* Обновляет индекс документации через [`patchDocIndexForDocs`](#patchdocindexfordocs).
* Возвращает объект с переданными `sectionId` и `reason`.

## validateDocs

### Зачем это нужно

Выполняет все проверки валидации документации по всем секциям и возвращает собранные проблемы.

### Что делает

* Перестраивает проектный индекс через [`rebuildIndexes`](#rebuildindexes).
* Для каждой секции вызывает [`validateOwnedEntities`](/docs/src/service/doc-validation#validateownedentities), [`validateDependencies`](/docs/src/service/doc-validation#validatedependencies), [`detectStaleBlocks`](/docs/src/service/doc-validation#detectstaleblocks) и, если `includeQuality === true`, [`validateBlockQuality`](/docs/src/service/doc-validation#validateblockquality).
* Агрегирует все проблемы в единый массив `issues`.

### На что можно положиться

* Всегда возвращает объект со свойством `issues` (может быть пустым).

## refreshStaleDocs

### Зачем это нужно

Сканирует секции документации на предмет устаревших блоков и в зависимости от режима сообщает, планирует перезапись или применяет пометки устаревания.

### Что делает

* Перестраивает индекс и фильтрует секции по скоупу через [`filterSectionsByScope`](/docs/src/service/stale-detection#filtersectionsbyscope).
* В режиме `"report"` возвращает сводку устаревших и удалённых блоков без изменений.
* В режиме `"rewrite_plan"` дополнительно строит контекстные наборы для перезаписи через [`buildRewriteContextBundle`](/docs/src/service/stale-detection#buildrewritecontextbundle).
* В режиме `"tombstone"` помечает устаревшие блоки через `applyTombstones`, обновляет индекс через [`patchDocIndexForDocs`](#patchdocindexfordocs) и [`loadOrRebuildIndexes`](#loadorrebuildindexes), затем повторно собирает удалённые блоки.

### На что можно положиться

* В режиме `"tombstone"` после применения пометок перезагружает индекс для получения актуальных данных.
* Гарантирует, что возвращаемый `RefreshStaleDocsResult` содержит поля, соответствующие режиму (через [`refreshStaleResult`](/docs/src/service/stale-detection#refreshstaleresult)).
* Не изменяет состояние документации в режимах `"report"` и `"rewrite_plan"`.

## generateDocsForEntity

### Зачем это нужно

Генерирует документацию для конкретной сущности по её идентификатору, используя LLM-пайплайн.

### Что делает

* Разрешает идентификатор через `resolveSectionsForId`: ищет секцию по id сущности или существующую секцию, владеющую сущностью.
* Делегирует [`runPipelineForSections`](#runpipelineforsections) без указания целевых блоков (генерирует все разрешённые блоки).

### На что можно положиться

* Бросает `CodeloreError("UNKNOWN_ENTITY")`, если `id` не является ни идентификатором секции, ни идентификатором сущности.
* Бросает `CodeloreError("UNKNOWN_SECTION")`, если сущность существует, но не имеет секции документации.
* Не создаёт новые секции — только генерирует содержимое существующих.

## generateDocsForScope

### Зачем это нужно

Генерирует документацию для области, заданной путями, файлами или идентификаторами сущностей, подготавливая новые секции и обновляя устаревшие.

### Что делает

* Приводит скоуп через [`prepareInitialDocs`](#prepareinitialdocs), создавая скелеты секций для новых сущностей, и согласовывает состояния документации через `reconcileScopedDocStates`.
* Запускает [`refreshStaleDocs`](#refreshstaledocs) в режиме `"tombstone"`, чтобы пометить устаревшие блоки, и собирает из них целевые блоки.
* Передаёт собранные блоки в [`runPipelineForSections`](#runpipelineforsections), которая выполняет двухфазную генерацию и возвращает итоговый результат.

### На что можно положиться

* Новосозданные через [`prepareInitialDocs`](#prepareinitialdocs) скелеты секций всегда включаются в последующий запуск [`runPipelineForSections`](#runpipelineforsections).
* При отсутствии скоупа метод не создаёт секции и не генерирует документацию; результатом будет пустой `updatedSections`.

## fixStaleDocs

### Зачем это нужно

Исправляет устаревшую документацию: помечает устаревшие блоки и запускает регенерацию целевых блоков через LLM.

### Что делает

* Вычисляет скоуп из переданных `sectionIds`, `files`, `paths`.
* Запускает `gateDepDocsCascade` для верификации блоков, устаревших только из-за изменения отпечатков зависимостей, и может сократить объём генерации.
* Вызывает [`refreshStaleDocs`](#refreshstaledocs) в режиме `"tombstone"` для пометки устаревших блоков.
* Извлекает целевые блоки из tombstoned записей и запускает [`runPipelineForSections`](#runpipelineforsections) для соответствующих секций.

### На что можно положиться

* При пустом скоупе метод не бросает ошибку — возвращает результат с пустыми массивами `updatedSections` и `failed`.
* `gateDepDocsCascade` может сократить количество генерируемых блоков, если блоки всё ещё валидны; это отражается в итоговом `tombstoned` списке.

## appendGenerationHistory

### Зачем это нужно

Добавление записи в историю генерации секции документации для последующего аудита.

### Что делает

* Загружает состояние документа через `docStateStorage.loadDocState`.
* При отсутствии состояния документа или секции завершается без изменений.
* Добавляет переданную запись в массив `generationHistory` состояния секции.
* Обновляет `generatedAt` и вызывает `docStateStorage.renderAndPersist` для сохранения.

### На что можно положиться

* Не бросает исключение при отсутствии состояния документа или секции — тихий возврат.
* Всегда персистит состояние после добавления записи.

## runPipelineForSections

### Зачем это нужно

Оркестрация двухфазной генерации документации для заданного набора секций.

### Что делает

* Создаёт провайдер через [`createConfiguredProvider`](/docs/src/llm/provider#createconfiguredprovider).
* Фильтрует переданные `sectionIds` — пропускает только те, для которых существует секция в индексе и известен путь владельца.
* Определяет целевые блоки из `targetBlocksBySection`, проверяет их допустимость по `collectAllowedBlocksForSection`.
* Запускает фазы `propagating` и `terminal` последовательно, каждая вызывает [`generateFileGroup`](/docs/src/llm/file-pipeline#generatefilegroup) с ограничением параллелизма из `config.llm.concurrency`.
* Собирает результаты: `updatedSections`, `skipped`, `failed`.

### На что можно положиться

* Секции без владельца или без пути в индексе пропускаются с добавлением в `skipped`.
* Дублирующиеся идентификаторы секций дедуплицируются через `new Set`.
* Фазы выполняются последовательно; внутри каждой фазы файлы обрабатываются параллельно с лимитом `pLimit`.
* Итоговые списки нормализуются: `mergeSectionSummaries` и `dedupeSkipped`.

## recordDepDocsFingerprints

### Зачем это нужно

Сохранение отпечатка документации зависимостей для каждой написанной секции.

### Что делает

* Группирует переданные секции по пути документа через [`groupBy`](/docs/src/service/helpers#groupby).
* Для каждого документа загружает состояние, находит соответствующие секции.
* Вычисляет отпечаток через `dependencyDocsFingerprint(collectDependencyDocs(index, [file]))`.
* Записывает отпечаток в поле `depDocsFingerprint` состояния секции.
* Персистит состояние, если хотя бы одна секция была изменена.

### На что можно положиться

* Обновляет отпечаток только для секций, владелец которых имеет исходный файл в индексе.
* Персистит документ только если в нём произошли изменения.

## readDocSection

### Зачем это нужно

Чтение готовой Markdown-строки секции документации для внешнего использования.

### Что делает

* Разрешает идентификатор секции через [`resolveSection`](#resolvesection), которая бросает `UNKNOWN_SECTION` при отсутствии.
* Загружает состояние секции через [`requireSectionState`](#requiresectionstate).
* Вызывает [`renderSection(sectionState, this.config)`](/docs/src/markdown/render-doc#rendersection) для форматирования и возвращает строку.

### На что можно положиться

* Всегда возвращает непустую строку для известного `sectionId`.
* Бросает ошибку с кодом `UNKNOWN_SECTION`, если секция не найдена в индексе.
* Бросает ошибку с кодом `UNKNOWN_DOC` или `UNKNOWN_SECTION`, если состояние отсутствует.

## readCodeEntity

### Зачем это нужно

Получение данных сущности кода вместе с её исходным кодом.

### Что делает

* Загружает полный индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
* Ищет сущность по `entityId`; при отсутствии бросает `UNKNOWN_ENTITY`.
* Возвращает копию объекта сущности с добавленным полем `code`, содержащим текст сущности из файла, полученный через `readEntityCode`.

### На что можно положиться

* Всегда возвращает объект с полем `code`, если `entityId` существует.
* Бросает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_ENTITY` для несуществующего идентификатора.

## readImpact

### Зачем это нужно

Получение информации о влиянии сущности на документацию и другие сущности.

### Что делает

* Загружает индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
* Вызывает [`getImpactForEntity(index.code, index.docs, entityId)`](/docs/src/graph/impact#getimpactforentity) для расчёта влияния.
* Возвращает результат вызова без дополнительной обработки.

### На что можно положиться

* Не проверяет существование сущности — полагается на [`getImpactForEntity`](/docs/src/graph/impact#getimpactforentity).
* Не бросает собственных исключений (делегирует проверки [`getImpactForEntity`](/docs/src/graph/impact#getimpactforentity)).

## readChange

### Зачем это нужно

Загружает сохранённую запись анализа изменения (`ChangeAnalysis`) по её идентификатору, делегируя поиск хранилищу.

### Что делает

* Бросает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_CHANGE`, если запись не найдена.
* Возвращает объект `ChangeAnalysis` из хранилища без постобработки.
* Не валидирует содержимое записи — доверяет хранилищу.

### На что можно положиться

Бросает исключение только с кодом `UNKNOWN_CHANGE`; любые другие ошибки хранилища (например, повреждённый JSON) пробрасываются без перехвата.

## readDocFile

### Зачем это нужно

Читает сырое содержимое файла документации по относительному пути и возвращает его как строку.

### Что делает

* Вычитывает файл через `readFile` из `node:fs/promises` в кодировке UTF-8.
* Путь интерпретируется относительно `config.rootDir`.
* Не проверяет, что файл является документом Codelore — возвращает произвольный текст.

### На что можно положиться

Всегда возвращает строку при успехе; не перехватывает ошибки файловой системы — они пробрасываются вызывающему. Кодировка всегда UTF-8, задана литералом `"utf8"` в вызове `readFile`.

## resolveSection

### Зачем это нужно

Разрешает идентификатор секции до её объекта `DocSection` и текущего проектного индекса.

### Что делает

* Загружает индекс через [`loadOrRebuildIndexes`](#loadorrebuildindexes).
* Ищет секцию в `index.docs.sections` по `sectionId`.
* Бросает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_SECTION`, если секция не найдена.
* Возвращает и индекс, и секцию — не только секцию.

### На что можно положиться

Бросает исключение только с кодом `UNKNOWN_SECTION`; не проверяет корректность данных секции (например, наличие блоков или связей).

## requireSectionState

### Зачем это нужно

Загружает состояние секции (`DocStateSection`) из хранилища, выбрасывая ошибку при отсутствии документа или секции.

### Что делает

* Загружает состояние документа через `docStateStorage.loadDocState`.
* Бросает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_DOC`, если состояние документа отсутствует.
* Бросает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_SECTION`, если секция отсутствует в состоянии.
* Возвращает и полное состояние документа (`DocState`), и секцию (`DocStateSection`).

### На что можно положиться

Выбрасывает исключение только с одним из двух кодов: `UNKNOWN_DOC` или `UNKNOWN_SECTION`, в зависимости от того, какой этап проверки не пройден. Не проверяет корректность данных секции (например, наличие блоков или версию).

## CodeloreService.translateScope

### Зачем это нужно

Обеспечивает обновление переводов блоков документации на все настроенные языки после завершения генерации или исправления устаревших блоков.

### Что делает

* Завершает работу досрочно, если `config.docs.translations` пуст — переводы не настроены.
* Загружает проектный индекс, фильтрует секции по скоупу и собирает уникальные пути документов.
* Для каждого документа загружает состояние, удаляет переводы для языков, исключённых из конфигурации.
* Для каждого настроенного языка переводит блоки, требующие перевода, и сохраняет результат в `block.translations`.

### На что можно положиться

* Не изменяет состояние документации, если `config.docs.translations` пуст.
* Переводит только блоки, у которых `rendered === true`, `staleSince === undefined` и тело не пусто.
* Считает перевод текущим, только если его фингерпринт исходника совпадает с текущим фингерпринтом тела блока и перевод не требует доработки.

### От чего зависит

Зависит от `this.config.docs.translations` для определения языков перевода; от `this.loadOrRebuildIndexes()` для получения проектного индекса; от [`filterSectionsByScope`](/docs/src/service/stale-detection#filtersectionsbyscope) для фильтрации секций по скоупу; от [`createConfiguredProvider`](/docs/src/llm/provider#createconfiguredprovider) для создания LLM-провайдера; от `pLimit` из `p-limit` для ограничения конкуренции; от `this.translateDoc` для выполнения перевода каждого документа.

### Кто и как использует

Вызывается из [`fixStaleDocs`](#fixstaledocs), [`generateDocsForEntity`](#generatedocsforentity) и [`generateDocsForScope`](#generatedocsforscope) после завершения основной генерации документации. Каждый вызывающий передаёт скоуп, ограничивающий набор секций для перевода. Метод выполняет следующие шаги: 1) досрочный возврат, если `config.docs.translations` пуст; 2) загрузка проектного индекса через [`loadOrRebuildIndexes`](#loadorrebuildindexes); 3) фильтрация секций по скоупу через [`filterSectionsByScope`](/docs/src/service/stale-detection#filtersectionsbyscope); 4) сбор уникальных путей документов; 5) для каждого документа сбор путей исходных файлов владельцев секций; 6) создание LLM-провайдера через [`createConfiguredProvider`](/docs/src/llm/provider#createconfiguredprovider) с параметрами из `runtime`; 7) параллельный вызов `translateDoc` для каждого документа с ограничением конкуренции из `config.llm.concurrency`.

### Чего не делает

Не изолирует ошибки отдельных документов: если `translateDoc` для одного документа выбрасывает исключение, весь `Promise.all` отклоняется, и перевод остальных документов не завершается. Не выполняет перевод, если `config.docs.translations` пуст — досрочный возврат в первой строке метода.

### Как менять и что проверять

1. Досрочный возврат при пустом `config.docs.translations` гарантирует, что без настроенных языков перевод не выполняется; конструкция: `if (this.config.docs.translations.length === 0) { return; }`. 2. Ограничение конкуренции через `pLimit(this.config.llm.concurrency)` гарантирует, что параллельные переводы документов не превышают настроенный лимит; конструкция: `const limit = pLimit(this.config.llm.concurrency);`.
