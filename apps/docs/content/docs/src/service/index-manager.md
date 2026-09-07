---
title: IndexManager
---

## Зачем это нужно

Управляет сборкой, кэшированием и проверкой свежести `ProjectIndex`.

## Что делает

* Координирует параллельную сборку код- и док-индексов через [`buildCodeIndex`](/docs/src/indexer/code-indexer#buildcodeindex) и [`buildDocIndex`](/docs/src/indexer/state-indexer#builddocindex).
* Проверяет свежесть загруженного индекса по времени модификации файлов относительно `generatedAt` (`persistedIndexIsFresh`).
* Хранит кэш индекса в приватном поле `cache`, сбрасывает его при ребилде через колбэк `onIndexChanged`.
* Делегирует точечное обновление документации методу [`patchDocIndexPaths`](/docs/src/indexer/state-indexer#patchdocindexpaths).

## На что можно положиться

* После вызова `rebuild` или `loadOrRebuild` поле `cache` содержит актуальный индекс.
* `loadOrRebuild` возвращает существующий кэш без повторной сборки, если он есть.
* `patchDocs` при отсутствующем кэше вызывает полный `rebuild`.
* `persistedIndexIsFresh` возвращает `false` при невалидной дате или наличии более нового файла.

## От чего зависит

* [`buildCodeIndex`](/docs/src/indexer/code-indexer#buildcodeindex) (`src/indexer/code-indexer.ts`) — построение индекса кода проекта.
* [`buildDocIndex`](/docs/src/indexer/state-indexer#builddocindex) (`src/indexer/state-indexer.ts`) — построение индекса документации.
* [`patchDocIndexPaths`](/docs/src/indexer/state-indexer#patchdocindexpaths) (`src/indexer/state-indexer.ts`) — инкрементальное обновление индекса документации.
* [`DocStateStorage`](/docs/src/storage/doc-state-storage#docstatestorage) (`src/storage/doc-state-storage.ts`) — управление файлами состояний документов.
* [`JsonStorage`](/docs/src/storage/json-storage#jsonstorage) (`src/storage/json-storage.ts`) — сохранение и загрузка `ProjectIndex` в JSON.
* `fastGlob` — поиск файлов исходного кода и файлов состояний для проверки свежести индекса.
* `stat` (`node:fs/promises`) — получение времени модификации файлов для проверки свежести.

## Кто и как использует

1. `IndexManager.rebuild` вызывается с `persist: true` и `renderDocs: true` — запускает полную перестройку индекса с сохранением на диск и перерендерингом документов.
2. `IndexManager.loadOrRebuild` используется для загрузки сохранённого индекса или перестройки, если кэш пуст.
3. `IndexManager.patchDocs` вызывается для инкрементального обновления индекса документации по переданным путям.
4. `IndexManager.rebuild` вызывается для перестройки индекса перед анализом изменений.
5. `IndexManager.loadOrRebuild` вызывается для загрузки или перестройки индекса при поиске затронутых секций.
6. `IndexManager.buildScopedIndex` вызывается для построения индекса только для указанной области видимости.

## Чего не делает

* Проверка свежести индекса (`persistedIndexIsFresh`) не учитывает изменения в конфигурации — сравниваются только времена модификации файлов исходного кода и файлов состояний.
* При ошибке `stat` для любого файла (например, файл удалён) время модификации считается равным 0, что может привести к ложному признанию индекса устаревшим.
* `buildScopedIndex` не использует кэш — каждый вызов строит индексы заново.

## Как менять и что проверять

* `persistedIndexIsFresh` проверяет, что все файлы исходного кода и состояний не новее `generatedAt` — при добавлении нового поля в `ProjectIndex` нужно убедиться, что `persistedIndexIsFresh` не пропустит устаревший индекс. Конструкция: `mtimes.every((mtime) => mtime <= generatedAt)`.
* `patchDocs` при отсутствующем кэше вызывает полный `rebuild` — при изменении логики [`patchDocIndexPaths`](/docs/src/indexer/state-indexer#patchdocindexpaths) нужно проверить, что `patchDocs` корректно обрабатывает случай пустого кэша. Конструкция: `if (!this.cache) { await this.rebuild(); return; }`.
