# groupRewritesByDoc

## Зачем это нужно

Группирует запросы на перезапись секций по пути документа для пакетной обработки.

## Что делает

- Проверяет существование секции в `sections` и выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_SECTION`, если секция не найдена.
- Возвращает `byDoc` — `Map`, где ключ — путь документа, значение — массив перезаписей для этого документа.
- Возвращает `docPathBySection` — `Map` от идентификатора секции к пути документа.

## На что можно положиться

Каждый элемент `rewrites` должен иметь `sectionId`, присутствующий в `sections`, иначе выбрасывается [`CodeloreError`](../errors.codelore.md#codeloreerror).

## От чего зависит

[`CodeloreError`](../errors.codelore.md#codeloreerror) (`src/errors.ts`) — единый формат ошибок с машинно-читаемым кодом.

## Кто и как использует

Вызывается [`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections) после нормализации входных секций. Функция группирует нормализованные перезаписи по пути документа. Затем вызывающий код итерирует полученный `byDoc` и для каждой группы вызывает применение перезаписей к документу. Результат возвращается в виде двух Map: `byDoc` для пакетной обработки и `docPathBySection` для обратного отображения.

## Как менять и что проверять

1. Каждая перезапись имеет известный `sectionId`: проверка `if (!section) { throw new CodeloreError("UNKNOWN_SECTION", ...) }`.
2. Каждая перезапись попадает ровно в одну группу документа: оператор `??` в `byDoc.get(section.docPath) ?? []` создаёт массив при первом обращении.

# applyRewritesToDoc

```ts
applyRewritesToDoc(docPath: string, rewrites: NormalizedRewriteSectionInput[], storage: DocStateStorage, entities: Record<string, CodeEntity>, config: CodeloreConfig, filteredBySection: Map<string, FilteredGeneratedBlock[]>): Promise<void>
```

## Зачем это нужно

Применяет набор перезаписей к состоянию одного документа и сохраняет результат.

## Что делает

- Загружает состояние документа через `storage.loadDocState(docPath)`; если состояние отсутствует, прерывает выполнение.
- Для каждой перезаписи находит секцию в загруженном состоянии; если секция отсутствует, прерывает выполнение, иначе передаёт пару в [`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection).
- После обработки всех перезаписей обновляет `state.generatedAt` и один раз сохраняет документ через `storage.renderAndPersist`.
- После сохранения наполняет переданный `filteredBySection` через [`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites).

## На что можно положиться

- Выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror), если состояние документа не найдено или секция отсутствует в состоянии.
- `state.generatedAt` устанавливается в текущую метку времени после применения всех перезаписей.

## От чего зависит

[`CodeloreError`](../errors.codelore.md#codeloreerror) (`src/errors.ts`) — единый формат ошибок.
[`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites) (`src/service/section-rewrite.ts`) — сбор отфильтрованных блоков.
[`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection) (`src/service/section-rewrite.ts`) — вливание сгенерированных блоков.
[`DocStateStorage`](../storage/doc-state-storage.codelore.md#docstatestorage) (`src/storage/doc-state-storage.ts`) — управление состоянием документов.

## Кто и как использует

Вызывается [`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections) для каждого документа. Функция загружает состояние документа через `storage.loadDocState(docPath)`. При отсутствии состояния выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_DOC`. Затем для каждой перезаписи проверяет наличие секции в состоянии; если секция отсутствует, выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_SECTION`. Вызывает [`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection) для слияния блоков. После обработки всех перезаписей обновляет `state.generatedAt` и сохраняет состояние через `storage.renderAndPersist(state)`. Затем вызывает [`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites) для сбора отфильтрованных блоков в предоставленный Map.

# collectFilteredBlocksForRewrites

## Зачем это нужно

Собирает отфильтрованные блоки для перезаписей, у которых установлен флаг `showFiltered`.

## Что делает

- Для каждой перезаписи с `showFiltered === true` получает состояние секции из `state.sections` и вызывает [`collectFilteredBlocksForResponse`](#collectfilteredblocksforresponse).
- Результат помещается в `filteredBySection` под ключом `rewrite.sectionId`.
- Не изменяет состояние документа.

## На что можно положиться

- Обрабатывает только те перезаписи, у которых `showFiltered` равно `true`.
- Не модифицирует переданное состояние.

## От чего зависит

[`collectFilteredBlocksForResponse`](#collectfilteredblocksforresponse) (`src/service/section-rewrite.ts`) — сбор отфильтрованных блоков для ответа.

## Кто и как использует

Вызывается [`applyRewritesToDoc`](#applyrewritestodoc) после сохранения состояния документа. Для каждой перезаписи из `rewrites`, у которой `showFiltered === true`, получает состояние секции из `state.sections` и вызывает [`collectFilteredBlocksForResponse`](#collectfilteredblocksforresponse). Результат помещается в `filteredBySection` под ключом `rewrite.sectionId`. Не изменяет состояние документа.

# mergeGeneratedBlocksIntoSection

```ts
mergeGeneratedBlocksIntoSection(sectionState: DocStateSection, rewrite: NormalizedRewriteSectionInput, entities: Record<string, CodeEntity>, config: CodeloreConfig): void
```

## Зачем это нужно

Вливает сгенерированные блоки перезаписи в состояние секции, обновляя фингерпринты, оценки, канонический язык и метаданные зависимостей.

## Что делает

- Для каждого блока из `rewrite.blocks` вычисляет фингерпринт через [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint), устанавливает тело, оценки, язык; сбрасывает поля устаревания.
- Добавляет идентификатор блока в `blockOrder` и `allowedBlocks`, только если его там ещё нет.
- Если у секции есть владелец (`owns[0]`), перезаписывает `depends` и `usedBy` из сущности владельца, отсортированные через [`uniqueSorted`](helpers.codelore.md#uniquesorted).
- Вызывает [`updateSectionStatusForBlocks`](#updatesectionstatusforblocks) для пересчёта статуса секции.

## На что можно положиться

- Пустой `rewrite.blocks` не добавляет и не изменяет блоки, но всё равно пересчитывает `depends`, `usedBy` и `signature` владельца и обновляет статус секции.
- `blockOrder` и `allowedBlocks` сохраняют порядок первого появления и не накапливают дубликаты: `push` выполняется только при `!includes(blockId)`.
- Если `sectionState.owns[0]` найден в `entities`, `depends` и `usedBy` становятся отсортированными уникальными значениями `owner.directDeps` и `owner.directUsages`; если владелец не найден, эти поля не изменяются.
- Для каждого влитого блока `body` обрезается через `.trim()`, `language` равен `config.docs.language`, `rendered` равен `true`, а `staleSince`, `staleReason`, `staleFacets` сбрасываются в `undefined`.
- Если [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) возвращает `undefined`, существующий `fingerprint` блока не очищается; если значение определено, оно записывается.
- Функция не выбрасывает исключений и мутирует `sectionState` на месте, не возвращая значения.

## От чего зависит

[`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) (`src/markdown/block-facets.ts`) — вычисление отпечатка блока.
[`uniqueSorted`](helpers.codelore.md#uniquesorted) (`src/service/helpers.ts`) — удаление дубликатов и сортировка.
[`updateSectionStatusForBlocks`](#updatesectionstatusforblocks) (`src/service/section-rewrite.ts`) — обновление статуса секции.

## Чего не делает

The function only processes blocks that appear in the `rewrite.blocks` input; any block not listed there is left unchanged, and the function does not add or remove blocks beyond the provided set. It does not handle the case where a block's `fingerprint` is undefined — in that situation the existing `fingerprint` value is preserved (not cleared).

# updateSectionStatusForBlocks

```ts
updateSectionStatusForBlocks(sectionState: DocStateSection): void
```

## Зачем это нужно

Обновляет статус секции на основе состояния устаревания её блоков.

## Что делает

- Если статус секции `review_needed`, функция завершается без изменений.
- Вычисляет статус: если все блоки имеют `staleSince !== undefined`, статус становится `stale`; иначе — `normal`.
- Не изменяет статус, если он уже `review_needed`.

## На что можно положиться

- Функция всегда перезаписывает `sectionState.status`, включая `review_needed`: в коде нет проверки `review_needed`.
- Переменная `anyStale` вычисляется, но не влияет на итоговый статус: обе ветви тернарного оператора при `allStale === false` дают `"normal"`.
- Функция не мутирует блоки и не выбрасывает исключений; изменяет только `sectionState.status`.

## От чего зависит

Не имеет внешних зависимостей, кроме типов.

## Кто и как использует

Вызывается [`mergeGeneratedBlocksIntoSection`](#mergegeneratedblocksintosection) после слияния блоков. Функция проверяет все блоки секции: если все блоки имеют `staleSince !== undefined`, статус становится `stale`; иначе — `normal`. Результат записывается в `sectionState.status`.

## Чего не делает

The function only updates status for blocks that appear in the `rewrite.blocks` input; blocks not listed are left with their existing status. It does not handle the case where a block's `fingerprint` is undefined — in that situation the existing `fingerprint` value is preserved (not cleared).

# updateStatusFromBlocks

## Зачем это нужно

Обновляет статус всех секций в состоянии документа на основе устаревания блоков.

## Что делает

- Проходит по всем секциям в `state.sections`.
- Для каждой секции, если её статус не `review_needed`, вычисляет статус по тому же правилу: все блоки устарели → `stale`, иначе `normal`.
- Не изменяет статус секций с `review_needed`.

## На что можно положиться

- Секции с `review_needed` пропускаются.
- Статус `stale` устанавливается только когда все блоки секции имеют `staleSince !== undefined`.

## От чего зависит

Не имеет внешних зависимостей, кроме типов.

## Кто и как использует

Вызывается `CodeloreService.applyTombstones` после установки stale-меток на блоки. Функция проходит по всем секциям состояния документа. Для каждой секции, если её статус не `review_needed`, вычисляет статус: если все блоки имеют `staleSince !== undefined`, статус становится `stale`, иначе `normal`.

## Как менять и что проверять

1. Секции с `review_needed` пропускаются: `if (section.status === "review_needed") { continue; }`.
2. Статус `stale` устанавливается только когда все блоки секции устарели: `allStale = blocks.length > 0 && blocks.every((block) => block.staleSince !== undefined)`.

# normalizeGeneratedRewrite

```ts
normalizeGeneratedRewrite(input: RewriteSectionInput, _config: CodeloreConfig): NormalizedRewriteSectionInput
```

## Зачем это нужно

Преобразует входные данные перезаписи секции в нормализованный формат для последующей обработки, проверяя наличие сгенерированных блоков и отфильтровывая только известные идентификаторы блоков.

## Что делает

- Проверяет, что `input.generatedBlocks` не пуст; при пустом объекте выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `MISSING_GENERATED_BLOCKS`.
- Извлекает из `input.generatedBlocks` только те блоки, чьи идентификаторы входят в `BLOCK_IDS`; остальные игнорирует.
- Устанавливает `showFiltered` в `false`, если в `input` не указано иное.
- Не проверяет содержимое блоков (текст, оценки) — делегирует валидацию вызывающему коду.

## На что можно положиться

- Возвращает объект с полем `sectionId`, равным `input.sectionId`.
- Поле `blocks` содержит только ключи из `BLOCK_IDS`, присутствующие в `input.generatedBlocks`.
- Поле `showFiltered` всегда имеет тип `boolean` (по умолчанию `false`).
- Функция не мутирует `input`.

## От чего зависит

The function uses `BLOCK_IDS` from `src/markdown/block-ids.ts` to filter the input blocks, keeping only those whose IDs are in that set. It also uses the `BlockId` type from the same module to type the filtered result.

## Кто и как использует

The function is invoked by [`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections) (in `src/service/codelore-service.ts`) as part of the rewrite pipeline. It receives the raw rewrite input and returns a normalized version with only valid blocks, which is then used to update section states.

## Как менять и что проверять

- The function enforces that only blocks with IDs in `BLOCK_IDS` are accepted; blocks with IDs outside this set are dropped. This is enforced by the `BLOCK_IDS` constant from `src/markdown/block-ids.ts`.
- The function enforces that the input must include `generatedBlocks`; otherwise it throws an error with the message `Rewrite input for "${input.sectionId}" must include generatedBlocks.` This is enforced by the `if (!input.generatedBlocks)` check.

# collectFilteredBlocksForResponse

```ts
collectFilteredBlocksForResponse(sectionState: DocStateSection, config: CodeloreConfig, includeText: boolean): FilteredGeneratedBlock[]
```

## Зачем это нужно

Собирает из состояния секции блоки, которые не были отрендерены и имеют оценки, и возвращает их в виде массива `FilteredGeneratedBlock` для включения в ответ вызывающему.

## Что делает

- Перебирает только блоки из `sectionState.allowedBlocks`.
- Включает в результат только блоки, у которых есть `scores` и `rendered` равен `false`.
- Вычисляет `finalScore` как минимум из `informativeness`, `novelty`, `specificity`.
- Извлекает порог из `config.thresholds.perBlockScore[blockId]` или `config.thresholds.minScore`.
- Включает поле `text` только если `includeText === true` и `block.body` не пуст.
- Не изменяет `sectionState`.

## На что можно положиться

- Возвращает массив (возможно пустой), никогда не `undefined`.
- Порядок элементов в массиве соответствует порядку `sectionState.allowedBlocks`.
- Каждый элемент содержит поля `blockId`, `novelFact`, `informativeness`, `novelty`, `specificity`, `finalScore`, `threshold`.
- Поле `text` присутствует только если `includeText === true` и `block.body` не пуст.

## От чего зависит

Функция использует только типовые интерфейсы из `src/types.ts`: `DocStateSection`, `CodeloreConfig`, `FilteredGeneratedBlock`. Других внешних зависимостей нет.

## Кто и как использует

1. [`collectFilteredBlocksForRewrites`](#collectfilteredblocksforrewrites) вызывает эту функцию для каждой перезаписи, у которой `showFiltered === true` и существует `sectionState`. 2. Функция собирает блоки с оценками и `rendered: false`, вычисляет `finalScore` как минимум из трёх метрик и определяет порог из конфигурации. 3. Поле `text` включается только если `includeText === true` и тело блока непустое. 4. Полученный массив сохраняется в карте `filteredBySection`.

## Как менять и что проверять

- Порядок элементов в результате соответствует порядку `sectionState.allowedBlocks`. Конструкция: `for (const blockId of sectionState.allowedBlocks)`.\n- Поле `text` включается только при `includeText === true` и непустом `block.body`. Конструкция: `...(includeText && block.body ? { text: block.body } : {})`.
