# IndexManager

```ts
class IndexManager
```

## Зачем это нужно

Управляет сборкой, кэшированием и проверкой свежести `ProjectIndex`.

## Что делает

- Организует параллельную сборку кодового и док-индексов через [`buildCodeIndex`](../indexer/code-indexer.codelore.md#buildcodeindex) и [`buildDocIndex`](../indexer/state-indexer.codelore.md#builddocindex), при необходимости достраивая сущности предметной области из `domainMap`.
- При загрузке (`loadOrRebuild`) возвращает сохранённый кэш, если он есть; иначе проверяет актуальность персистентного индекса по временам модификации исходных файлов и файлов состояний (`persistedIndexIsFresh`) и перестраивает индекс, если запись устарела.
- Метод `patchDocs` при отсутствующем кэше запускает полный ребилд; при наличии — инкрементально обновляет документацию через [`patchDocIndexPaths`](../indexer/state-indexer.codelore.md#patchdocindexpaths) и синхронизирует `generatedAt`.
- Строит скоупированный индекс (`buildScopedIndex`) без использования кэша и без сохранения на диск.

## На что можно положиться

- После любого вызова `rebuild` или `loadOrRebuild` поле `cache` содержит новейший инстанс `ProjectIndex`, а геттер `cached` возвращает именно его.
- `persistedIndexIsFresh` возвращает `true` только если все существующие файлы (исходные и состояний) не новее `generatedAt`; любое отсутсвие файла или ошибка `stat` приводят к считанию времени 0, что может сделть индекс устаревшим.
- `patchDocs` гарантирует, что поле `cache` остаётся актуальным: при отсуствии предварительного индекса вызывается полный ребилд, после чего можно безопасно обращаться к `cached`.
- `buildScopedIndex` не влияет на кэш и не вызывет побочных эффэктов — результат возвращается напрямую.
- Методы `rebuild` и `patchDocs` вызывают колбек `onIndexChanged` (предоставленный извне), чтобы клиент мог сбросить производные кэши.

## От чего зависит

- [`buildCodeIndex`](../indexer/code-indexer.codelore.md#buildcodeindex) (`src/indexer/code-indexer.ts`) — построение индекса кода проекта.
- [`buildDocIndex`](../indexer/state-indexer.codelore.md#builddocindex) (`src/indexer/state-indexer.ts`) — построение индекса документации.
- [`patchDocIndexPaths`](../indexer/state-indexer.codelore.md#patchdocindexpaths) (`src/indexer/state-indexer.ts`) — инкрементальное обновление индекса документации.
- [`DocStateStorage`](../storage/doc-state-storage.codelore.md#docstatestorage) (`src/storage/doc-state-storage.ts`) — управление файлами состояний документов.
- [`JsonStorage`](../storage/json-storage.codelore.md#jsonstorage) (`src/storage/json-storage.ts`) — сохранение и загрузка `ProjectIndex` в JSON.
- `fastGlob` — поиск файлов исходного кода и файлов состояний для проверки свежести индекса.
- `stat` (`node:fs/promises`) — получение времени модификации файлов для проверки свежести.

## Кто и как использует

- [`CodeloreService`](codelore-service.codelore.md#codeloreservice) использует `rebuild` с `persist: true` и `renderDocs: true` для полной перестройки индекса с сохранением на диск и перерендерингом документов.
- [`CodeloreService`](codelore-service.codelore.md#codeloreservice) использует `loadOrRebuild` для загрузки сохранённого индекса или перестройки, если кэш пуст.
- [`CodeloreService`](codelore-service.codelore.md#codeloreservice) использует `patchDocs` для инкрементального обновления индекса документации по переданным путям.
- [`CodeloreService`](codelore-service.codelore.md#codeloreservice) использует `rebuild` для перестройки индекса перед анализом изменений.
- [`CodeloreService`](codelore-service.codelore.md#codeloreservice) использует `loadOrRebuild` для загрузки или перестройки индекса при поиске затронутых секций.
- [`CodeloreService`](codelore-service.codelore.md#codeloreservice) использует `buildScopedIndex` для построения индекса только для указанной области видимости.

## Чего не делает

- Проверка свежести индекса (`persistedIndexIsFresh`) не учитывает изменения в конфигурации — сравниваются только времена модификации файлов исходного кода и файлов состояний.
- При ошибке `stat` для любого файла (например, файл удалён) время модификации считается равным 0, что может привести к ложному признанию индекса устаревшим.
- `buildScopedIndex` не использует кэш — каждый вызов строит индексы заново.

## Как менять и что проверять

- `persistedIndexIsFresh` проверяет, что все файлы исходного кода и состояний не новее `generatedAt` — при добавлении нового поля в `ProjectIndex` нужно убедиться, что `persistedIndexIsFresh` не пропустит устаревший индекс. Конструкция: `mtimes.every((mtime) => mtime <= generatedAt)`.
- `patchDocs` при отсутствующем кэше вызывает полный `rebuild` — при изменении логики [`patchDocIndexPaths`](../indexer/state-indexer.codelore.md#patchdocindexpaths) нужно проверить, что `patchDocs` корректно обрабатывает случай пустого кэша. Конструкция: `if (!this.cache) { await this.rebuild(); return; }`.
