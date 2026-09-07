---
title: groupRewritesByDoc
---

## Зачем это нужно

Группирует запросы на перезапись секций по пути документа для пакетной обработки.

## Что делает

* Проверяет существование секции в `sections` и выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_SECTION`, если секция не найдена.
* Возвращает `byDoc` — `Map`, где ключ — путь документа, значение — массив перезаписей для этого документа.
* Возвращает `docPathBySection` — `Map` от идентификатора секции к пути документа.

## На что можно положиться

Каждый элемент `rewrites` должен иметь `sectionId`, присутствующий в `sections`, иначе выбрасывается [`CodeloreError`](/docs/src/errors#codeloreerror).

## От чего зависит

[`CodeloreError`](/docs/src/errors#codeloreerror) (`src/errors.ts`) — единый формат ошибок с машинно-читаемым кодом.

## Кто и как использует

Вызывается [`CodeloreService.rewriteSections`](/docs/src/service/codelore-service#rewritesections) после нормализации входных секций. Функция группирует нормализованные перезаписи по пути документа. Затем вызывающий код итерирует полученный `byDoc` и для каждой группы вызывает применение перезаписей к документу. Результат возвращается в виде двух Map: `byDoc` для пакетной обработки и `docPathBySection` для обратного отображения.

## Как менять и что проверять

1. Каждая перезапись имеет известный `sectionId`: проверка `if (!section) { throw new CodeloreError("UNKNOWN_SECTION", ...) }`.
2. Каждая перезапись попадает ровно в одну группу документа: оператор `??` в `byDoc.get(section.docPath) ?? []` создаёт массив при первом обращении.

## applyRewritesToDoc

### Зачем это нужно

Применяет набор перезаписей к состоянию одного документа и сохраняет результат.

### Что делает

* Загружает состояние документа через `storage.loadDocState`; если состояние отсутствует, выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_DOC`.
* Для каждой перезаписи проверяет наличие секции в состоянии; если секция отсутствует, выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_SECTION`.
* Вызывает [`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection) для каждой перезаписи, затем обновляет `state.generatedAt` и сохраняет через `storage.renderAndPersist`.
* После сохранения вызывает [`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites) для сбора отфильтрованных блоков.

### На что можно положиться

* Выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror), если состояние документа не найдено или секция отсутствует в состоянии.
* `state.generatedAt` устанавливается в текущую метку времени после применения всех перезаписей.

### От чего зависит

[`CodeloreError`](/docs/src/errors#codeloreerror) (`src/errors.ts`) — единый формат ошибок.
[`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites) (`src/service/section-rewrite.ts`) — сбор отфильтрованных блоков.
[`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection) (`src/service/section-rewrite.ts`) — вливание сгенерированных блоков.
[`DocStateStorage`](/docs/src/storage/doc-state-storage#docstatestorage) (`src/storage/doc-state-storage.ts`) — управление состоянием документов.

### Кто и как использует

Вызывается [`CodeloreService.rewriteSections`](/docs/src/service/codelore-service#rewritesections) для каждого документа. Функция загружает состояние документа через `storage.loadDocState(docPath)`. При отсутствии состояния выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_DOC`. Затем для каждой перезаписи проверяет наличие секции в состоянии; если секция отсутствует, выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `UNKNOWN_SECTION`. Вызывает [`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection) для слияния блоков. После обработки всех перезаписей обновляет `state.generatedAt` и сохраняет состояние через `storage.renderAndPersist(state)`. Затем вызывает [`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites) для сбора отфильтрованных блоков в предоставленный Map.

### Как менять и что проверять

1. Состояние документа должно существовать: проверка `if (!state) { throw new CodeloreError("UNKNOWN_DOC", ...) }`.
2. Каждая секция должна присутствовать в состоянии: проверка `if (!sectionState) { throw new CodeloreError("UNKNOWN_SECTION", ...) }`.

## collectFilteredBlocksForRewrites

### Зачем это нужно

Собирает отфильтрованные блоки для перезаписей, у которых установлен флаг `showFiltered`.

### Что делает

* Для каждой перезаписи с `showFiltered === true` получает состояние секции из `state.sections` и вызывает [`collectFilteredBlocksForResponse`](#collectfilteredblocksforresponse).
* Результат помещается в `filteredBySection` под ключом `rewrite.sectionId`.
* Не изменяет состояние документа.

### На что можно положиться

* Обрабатывает только те перезаписи, у которых `showFiltered` равно `true`.
* Не модифицирует переданное состояние.

### От чего зависит

[`collectFilteredBlocksForResponse`](#collectfilteredblocksforresponse) (`src/service/section-rewrite.ts`) — сбор отфильтрованных блоков для ответа.

### Кто и как использует

Вызывается [`applyRewritesToDoc`](#applyrewritestodoc) после сохранения состояния документа. Для каждой перезаписи из `rewrites`, у которой `showFiltered === true`, получает состояние секции из `state.sections` и вызывает [`collectFilteredBlocksForResponse`](#collectfilteredblocksforresponse). Результат помещается в `filteredBySection` под ключом `rewrite.sectionId`. Не изменяет состояние документа.

## mergeGeneratedBlocksIntoSection

### Зачем это нужно

Вливает сгенерированные блоки перезаписи в состояние секции, обновляя фингерпринты, оценки, канонический язык и метаданные зависимостей.

### Что делает

* Для каждого блока из `rewrite.blocks` вычисляет фингерпринт через [`computeBlockFingerprint`](/docs/src/markdown/block-facets#computeblockfingerprint), устанавливает тело, оценки, язык; сбрасывает поля устаревания.
* Добавляет идентификатор блока в `blockOrder` и `allowedBlocks`, только если его там ещё нет.
* Если у секции есть владелец (`owns[0]`), перезаписывает `depends` и `usedBy` из сущности владельца, отсортированные через [`uniqueSorted`](/docs/src/service/helpers#uniquesorted).
* Вызывает [`updateSectionStatusForBlocks`](#updatesectionstatusforblocks) для пересчёта статуса секции.

### На что можно положиться

* `blockOrder` и `allowedBlocks` никогда не содержат дубликатов: добавление происходит только при отсутствии (`!sectionState.blockOrder.includes(blockId)`).
* `depends` и `usedBy` перезаписываются исключительно при наличии владельца (`if (owner) { ... }`).
* Поля `staleSince`, `staleReason` и `staleFacets` сбрасываются в `undefined` для каждого влитого блока.

### От чего зависит

[`computeBlockFingerprint`](/docs/src/markdown/block-facets#computeblockfingerprint) (`src/markdown/block-facets.ts`) — вычисление отпечатка блока.
[`uniqueSorted`](/docs/src/service/helpers#uniquesorted) (`src/service/helpers.ts`) — удаление дубликатов и сортировка.
[`updateSectionStatusForBlocks`](#updatesectionstatusforblocks) (`src/service/section-rewrite.ts`) — обновление статуса секции.

### Кто и как использует

Вызывается [`applyRewritesToDoc`](#applyrewritestodoc) для каждой перезаписи. Внутри: 1) Для каждого блока из `rewrite.blocks` вычисляется фингерпринт через [`computeBlockFingerprint`](/docs/src/markdown/block-facets#computeblockfingerprint), создаётся или обновляется `DocStateBlock` — устанавливаются `body` (обрезанный через `.trim()`), `language` из `config.docs.language`, `rendered` в `true`, `scores` (informativeness, novelty, specificity, novelFact), при наличии фингерпринта — `fingerprint`; поля `staleSince`, `staleReason`, `staleFacets` сбрасываются в `undefined`. Если `blockId` отсутствует в `blockOrder` или `allowedBlocks`, он добавляется. 2) После цикла, если у секции есть владелец (`sectionState.owns[0]` присутствует в `entities`), `depends` и `usedBy` перезаписываются через [`uniqueSorted([...owner.directDeps])`](/docs/src/service/helpers#uniquesorted) и [`uniqueSorted([...owner.directUsages])`](/docs/src/service/helpers#uniquesorted). 3) В конце вызывается [`updateSectionStatusForBlocks`](#updatesectionstatusforblocks).

### Как менять и что проверять

1. Дубликаты в `blockOrder` и `allowedBlocks` предотвращены: перед `push` стоит `if (!sectionState.blockOrder.includes(blockId))` и `if (!sectionState.allowedBlocks.includes(blockId))`. Тестов не видно.
2. Поля устаревания сбрасываются в `undefined` для каждого влитого блока: три присваивания `block.staleSince = undefined; block.staleReason = undefined; block.staleFacets = undefined;`. Тестов не видно.

## updateSectionStatusForBlocks

### Зачем это нужно

Обновляет статус секции на основе состояния устаревания её блоков.

### Что делает

* Если статус секции `review_needed`, функция завершается без изменений.
* Вычисляет статус: если все блоки имеют `staleSince !== undefined`, статус становится `stale`; иначе — `normal`.
* Не изменяет статус, если он уже `review_needed`.

### На что можно положиться

* Статус `review_needed` никогда не перезаписывается.
* Статус `stale` устанавливается только когда все блоки устарели; при наличии хотя бы одного неустаревшего блока статус `normal`.

### От чего зависит

Не имеет внешних зависимостей, кроме типов.

### Кто и как использует

Вызывается [`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection) после слияния блоков. Если статус секции `review_needed`, функция завершается досрочно. Иначе проверяет все блоки: если хотя бы один блок имеет `staleSince !== undefined`, но не все, статус становится `normal`; если все блоки устарели, статус становится `stale`. Результат записывается в `sectionState.status`.

## updateStatusFromBlocks

### Зачем это нужно

Обновляет статус всех секций в состоянии документа на основе устаревания блоков.

### Что делает

* Проходит по всем секциям в `state.sections`.
* Для каждой секции, если её статус не `review_needed`, вычисляет статус по тому же правилу: все блоки устарели → `stale`, иначе `normal`.
* Не изменяет статус секций с `review_needed`.

### На что можно положиться

* Секции с `review_needed` пропускаются.
* Статус `stale` устанавливается только когда все блоки секции имеют `staleSince !== undefined`.

### От чего зависит

Не имеет внешних зависимостей, кроме типов.

### Кто и как использует

Вызывается `CodeloreService.applyTombstones` после установки stale-меток на блоки. Функция проходит по всем секциям состояния документа. Для каждой секции, если её статус не `review_needed`, вычисляет статус: если все блоки имеют `staleSince !== undefined`, статус становится `stale`, иначе `normal`.

### Как менять и что проверять

1. Секции с `review_needed` пропускаются: `if (section.status === "review_needed") { continue; }`.
2. Статус `stale` устанавливается только когда все блоки секции устарели: `allStale = blocks.length > 0 && blocks.every((block) => block.staleSince !== undefined)`.

## normalizeGeneratedRewrite

### Зачем это нужно

Преобразует входные данные перезаписи секции в нормализованный формат для последующей обработки, проверяя наличие сгенерированных блоков и отфильтровывая только известные идентификаторы блоков.

### Что делает

* Проверяет, что `input.generatedBlocks` не пуст; при пустом объекте выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `MISSING_GENERATED_BLOCKS`.
* Извлекает из `input.generatedBlocks` только те блоки, чьи идентификаторы входят в `BLOCK_IDS`; остальные игнорирует.
* Устанавливает `showFiltered` в `false`, если в `input` не указано иное.
* Не проверяет содержимое блоков (текст, оценки) — делегирует валидацию вызывающему коду.

### На что можно положиться

* Возвращает объект с полем `sectionId`, равным `input.sectionId`.
* Поле `blocks` содержит только ключи из `BLOCK_IDS`, присутствующие в `input.generatedBlocks`.
* Поле `showFiltered` всегда имеет тип `boolean` (по умолчанию `false`).
* Функция не мутирует `input`.

### От чего зависит

* [`CodeloreError`](/docs/src/errors#codeloreerror) (`src/errors.ts`) — выбрасывается при пустом `input.generatedBlocks`.
* `BLOCK_IDS` (`src/markdown/block-ids.ts`) — ограничивает набор допустимых идентификаторов блоков.
* `BlockId` (`src/markdown/block-ids.ts`) — тип для ключей в результирующем объекте блоков.

### Кто и как использует

1. [`CodeloreService.rewriteSections`](/docs/src/service/codelore-service#rewritesections) вызывает функцию для каждого элемента массива `sections`.
2. Полученные `NormalizedRewriteSectionInput` группируются по документу.
3. Для каждой группы документов применяется слияние сгенерированных блоков в состояние.
4. После применения всех перезаписей вызывается `patchDocIndexForDocs` для обновления индекса.
5. В результате возвращается массив объектов с `sectionId`, `docPath` и опциональными `filteredBlocks`.

### Как менять и что проверять

* Идентификаторы блоков, не входящие в `BLOCK_IDS`, отбрасываются. Конструкция: `for (const blockId of BLOCK_IDS) { const block = input.generatedBlocks[blockId]; if (block) { blocks[blockId] = block; } }`.
* Пустой `input.generatedBlocks` вызывает ошибку `MISSING_GENERATED_BLOCKS`. Конструкция: `if (!input.generatedBlocks || Object.keys(input.generatedBlocks).length === 0) { throw new CodeloreError(...); }`.

## collectFilteredBlocksForResponse

### Зачем это нужно

Собирает из состояния секции блоки, которые не были отрендерены и имеют оценки, и возвращает их в виде массива `FilteredGeneratedBlock` для включения в ответ вызывающему.

### Что делает

* Перебирает только блоки из `sectionState.allowedBlocks`.
* Включает в результат только блоки, у которых есть `scores` и `rendered` равен `false`.
* Вычисляет `finalScore` как минимум из `informativeness`, `novelty`, `specificity`.
* Извлекает порог из `config.thresholds.perBlockScore[blockId]` или `config.thresholds.minScore`.
* Включает поле `text` только если `includeText === true` и `block.body` не пуст.
* Не изменяет `sectionState`.

### На что можно положиться

* Возвращает массив (возможно пустой), никогда не `undefined`.
* Порядок элементов в массиве соответствует порядку `sectionState.allowedBlocks`.
* Каждый элемент содержит поля `blockId`, `novelFact`, `informativeness`, `novelty`, `specificity`, `finalScore`, `threshold`.
* Поле `text` присутствует только если `includeText === true` и `block.body` не пуст.

### От чего зависит

* `DocStateSection`, `CodeloreConfig`, `FilteredGeneratedBlock` из `src/types.ts` — интерфейсы, используемые в сигнатуре и реализации.

### Кто и как использует

1. [`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites) для каждой перезаписи с `showFiltered: true` вызывает `collectFilteredBlocksForResponse` с `includeText: true`.
2. Функция собирает блоки с оценками и `rendered: false`, вычисляет `finalScore` и порог, опционально включает текст.
3. Полученный массив сохраняется в карте `filteredBySection`, которая затем используется для построения ответа.

### Как менять и что проверять

* Порядок элементов в результате соответствует порядку `sectionState.allowedBlocks`. Конструкция: `for (const blockId of sectionState.allowedBlocks)`.
* Поле `text` включается только при `includeText === true` и непустом `block.body`. Конструкция: `...(includeText && block.body ? { text: block.body } : {})`.
