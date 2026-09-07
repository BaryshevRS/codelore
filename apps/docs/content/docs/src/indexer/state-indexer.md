---
title: buildDocIndex
---

## Зачем это нужно

Строит индекс документации из состояний, хранящихся в [`DocStateStorage`](/docs/src/storage/doc-state-storage#docstatestorage), для поиска секций по идентификатору, файлу и сущности.

## Что делает

* Загружает состояния всех документов через [`DocStateStorage`](/docs/src/storage/doc-state-storage#docstatestorage) и преобразует их в индексные секции с обратными картами (`fileToSections`, `entityToSections`).
* Сортирует пути документов и списки сущностей для детерминированного вывода.
* Не изменяет состояния документов и не анализирует исходный код – строит индекс только из прочитанных состояний.
* Не проверяет целостность связей – копирует данные без валидации.

## На что можно положиться

* Возвращает индекс с версией `INDEX_VERSION` и отметкой времени генерации.
* Сортирует пути документов и массивы `entityToSections` для детерминированного вывода.
* Пропускает состояния, для которых `loadDocState` вернул `undefined`.
* При обнаружении дублирующегося `sectionId` в разных документах выбрасывает `CodeloreError` с кодом `DUPLICATE_SECTION`.
* Гарантирует, что карты `sections`, `fileToSections`, `entityToSections` не `undefined` даже при пустом наборе состояний.

## От чего зависит

* [`DocStateStorage`](/docs/src/storage/doc-state-storage#docstatestorage) (`src/storage/doc-state-storage.ts`) — чтение списка и загрузка состояний секций.
* `CodeloreError` ([`src/errors.ts`](/docs/src/errors)) — формирование ошибки при дублирующемся идентификаторе секции.

## Кто и как использует

Вызывается из `CodeloreService.buildPrepareInitialDocsIndex` и `CodeloreService.rebuildIndexes`. В обоих сценариях выполняется параллельно с `buildCodeIndex`. В `rebuildIndexes` перед вызовом может быть выполнено `reapplyConfigToAllDocs` (если `options.renderDocs`). Результат используется для построения `ProjectIndex`, кэшируется в `projectIndexCache`. Загрузка состояний происходит последовательно, по одному документу; при обнаружении дублирующегося `sectionId` работа прерывается с `CodeloreError`.

## Как менять и что проверять

* Дублирование `sectionId` в разных документах приводит к аварийному завершению через `throw new CodeloreError("DUPLICATE_SECTION", ...)`; тест `state-indexer.test.ts` проверяет это поведение.
* Сортировка путей документов через `(await stateStorage.listDocStates()).sort()` гарантирует детерминированный порядок секций в `entityToSections`; тест `state-indexer.test.ts` проверяет стабильность вывода.
* Пропуск состояний, для которых `loadDocState` вернул `undefined`, реализован через `if (!state) { continue; }`; тест `state-indexer.test.ts` проверяет обработку отсутствующего файла.

## patchDocIndexPaths

### Зачем это нужно

Инкрементальное обновление `DocIndex` для заданного набора файлов без полной перестройки.

### Что делает

* Удаляет из индекса все секции для каждого `docPath`, включая очистку привязок к сущностям в `entityToSections`.
* Загружает актуальные состояния через `stateStorage.loadDocState` и добавляет секции заново.
* Сортирует только списки затронутых сущностей и обновляет `generatedAt`.
* Не изменяет состояния на диске и не проверяет целостность связей – работает только с переданными путями и существующими данными.

### На что можно положиться

* После вызова `index.generatedAt` обновляется на текущее время.
* Если `docPath` не найден в `stateStorage`, его записи удаляются из индекса без добавления новых.

### От чего зависит

* `CodeloreError` ([`src/errors.ts`](/docs/src/errors)) — формат ошибки дублирования секций, используется в `addSectionToIndex`.
* [`DocStateStorage`](/docs/src/storage/doc-state-storage#docstatestorage) (`src/storage/doc-state-storage.ts`) — загрузка состояний документов через `loadDocState`.

### Кто и как использует

Вызывается из `CodeloreService.patchDocIndexForDocs` при изменении набора документов (например, после записи файла или обновления метаданных). Процесс:

1. Удаляет из индекса все секции для каждого переданного `docPath`, включая привязки к сущностям в `entityToSections`.
2. Загружает актуальное состояние документа через `stateStorage.loadDocState`.
3. Добавляет секции заново через `addSectionToIndex`.
4. Сортирует списки затронутых сущностей и обновляет `index.generatedAt`.

### Как менять и что проверять

* Удаление записей из `entityToSections` выполняется через `bucket.filter((id) => id !== sectionId)` и `delete index.entityToSections[ownedEntity]` при пустом остатке; тест `state-indexer.test.ts` проверяет корректность очистки.
* Сортировка затронутых сущностей через `index.entityToSections[entity]?.sort()` гарантирует детерминированный порядок; тест `state-indexer.test.ts` проверяет стабильность после патча.
* Обновление `index.generatedAt = new Date().toISOString()` в конце функции; тест `state-indexer.test.ts` проверяет, что метка времени обновляется.
