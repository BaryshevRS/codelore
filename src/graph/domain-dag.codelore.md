# buildDomainDag

```ts
buildDomainDag(code: CodeIndex, fileToDomain: ReadonlyMap<string, string>): DepGraph
```

## Зачем это нужно

Превращает граф зависимостей между файлами в граф зависимостей между доменами, сопоставляя каждый файл его домену через fileToDomain.

## Что делает

Создаёт запись в графе для каждого домена, который встречается в fileToDomain, даже если у него нет исходящих рёбер. Для каждого файла из buildFileDag(code) определяет домен-источник через fileToDomain.get(file) и пропускает файл, если домен не найден. Для каждой зависимости файла определяет домен-цель и добавляет ребро от домена-источника к домену-цели, если цель существует и отличается от источника.

## На что можно положиться

Функция возвращает граф зависимостей между доменами: для каждого домена — множество доменов, от которых он зависит. Файлы, не сопоставленные ни с одним доменом (fileToDomain.get(file) === undefined), пропускаются и не порождают рёбер. Рёбра от домена к самому себе (to === from) не добавляются. Домены, которые не встречаются ни в одном файле, не получают записей в графе.

## От чего зависит

- [`buildFileDag`](file-dag.codelore.md#buildfiledag) from `src/graph/file-dag.ts` — computes the file-level dependency graph used to derive domain dependencies.

## Кто и как использует

- Called by [`buildDomainEntities`](../indexer/domain-entities.codelore.md#builddomainentities) in `src/indexer/domain-entities.ts` to compute the domain dependency graph; the caller then inverts the DAG to build a dependents map and iterates over `dag.keys()` to construct domain entities.
- Called by `CodeloreService.tierGenerationWaves` in [`src/service/codelore-service.ts`](../service/codelore-service.codelore.md) to compute the domain DAG for wave generation.

## Чего не делает

- The function only includes domains that are present in the `fileToDomain` mapping, so domains without any associated file are not represented.
- The function does not emit a project entity; it returns only the domain dependency graph without creating any project entities.

## Как менять и что проверять

- The function enforces that each domain appears exactly once as a key in the graph, using a Set to collect unique domain IDs from the input mapping.
- The function enforces that self-dependencies are not added, by checking that the file's domain differs from the import's domain.
