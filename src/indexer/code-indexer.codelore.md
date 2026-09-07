# buildCodeIndex

## Зачем это нужно

Построение полного индекса кода проекта: отображение всех файлов и экспортированных сущностей с их прямыми зависимостями и документационными метаданными.

## Что делает

- Не обрабатывает файлы за пределами `sourceGlobs`, кроме явно указанных в `scope`; не индексирует неэкспортированные сущности.
- Не прослеживает реэкспорты через `export * from` — зависимость считается с исходным файлом реэкспорта; разрешение зависимостей и вычисление метаданных делегировано вспомогательным функциям.

## На что можно положиться

- Возвращает `CodeIndex` с `version`, равным `INDEX_VERSION`.
- Каждая сущность имеет уникальный `id` вида `symbol:path#name` (для экспортированных) или `file:path` (для файла).
- `directDeps` каждой сущности содержит только идентификаторы сущностей, присутствующих в том же индексе.
- `directDeps` и `directUsages` всегда отсортированы лексикографически.
- Для каждого обработанного файла в `entities` присутствует сущность с `type: "file"`.

## От чего зависит

- `fast-glob` — поиск исходных файлов по glob-паттернам.
- `ts-morph` — парсинг TypeScript AST и разрешение импортов.
- `sha256` ([`src/utils/hash.ts`](../utils/hash.codelore.md)) — хеширование содержимого сущностей.
- [`relativeProjectPath`](../utils/path.codelore.md#relativeprojectpath) (`src/utils/path.ts`) — нормализация путей относительно корня.
- `isProbablyExcluded` ([`src/utils/path.ts`](../utils/path.codelore.md)) — эвристика исключения путей.
- `decideDocumentationRoles` ([`src/analysis/decision-pass.ts`](../analysis/decision-pass.codelore.md)) — определение роли документации.
- `computeEntityMetrics` ([`src/analysis/entity-metrics.ts`](../analysis/entity-metrics.codelore.md)) — вычисление метрик сущностей.
- `analyzeClassCohesion` ([`src/analysis/class-cohesion.ts`](../analysis/class-cohesion.codelore.md)) — анализ связности классов.
- `detectPrivateWrappers` ([`src/analysis/wrapper-detector.ts`](../analysis/wrapper-detector.codelore.md)) — обнаружение приватных обёрток.
- `determineBlockInclusion` ([`src/analysis/block-inclusion.ts`](../analysis/block-inclusion.codelore.md)) — решение о включении блоков документации.

## Кто и как использует

- `CodeloreService.buildPrepareInitialDocsIndex` вызывает `buildCodeIndex` параллельно с `buildDocIndex`, передавая `scope` из входных параметров для фильтрации набора файлов; результат объединяется в `ProjectIndex`.
- [`CodeloreService.prepareInitialDocs`](../service/codelore-service.codelore.md#prepareinitialdocs) при наличии скоупа повторно вызывает `buildCodeIndex` без `scope` для записи новых секций, чтобы получить полный граф зависимостей.
- `CodeloreService.rebuildIndexes` вызывает `buildCodeIndex` без `scope` для построения полного индекса, который затем кешируется в сервисе.

## Чего не делает

- Индексируются только `.ts` и `.js` файлы — `.d.ts`, `.cts`, `.mts`, `.mjs` игнорируются.
- Не индексируются неэкспортированные сущности — граф зависимостей строится только по экспортируемым символам.
- При отсутствии `tsconfig.json` используется `ModuleResolutionKind.NodeNext` — импорты с алиасами `paths` могут не разрешиться.
- Реэкспорты через `export * from` не прослеживаются — зависимость считается только с исходным файлом реэкспорта.

## Как менять и что проверять

1. Инвариант уникальности id экспортированных сущностей обеспечивается проверкой `seenIds.has(record.entity.id)` в `collectExportedEntityRecords` — повторные декларации с тем же id не создают запись.
2. Инвариант фильтрации `directDeps` только по существующим сущностям обеспечивается вызовом `filter((depId) => Boolean(entities[depId]))` в `populateDependencies` — зависимости, чьи id отсутствуют в индексе, не попадают в массив.
3. Инвариант лексикографической сортировки `directDeps` и `directUsages` обеспечивается вызовом `.sort()` после сборки массивов: `record.entity.directDeps = [...directDeps].filter(...).sort();` и `dep.directUsages.sort();`.
