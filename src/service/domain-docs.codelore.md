# domain-docs.ts

## Зачем это нужно

The module defines the data shapes and path derivation rules that the domain-doc preparation flow relies on to persist and locate per-entity documentation.

## Что делает

The module defines the doc-state shape and the tier path derivation rule, both used by the preparation flow to save and locate docs.

## На что можно положиться

The module establishes the domain-doc state contract: a doc state is a record of section bodies keyed by section id, with an optional memberDocsFingerprint, and tier doc paths are derived from entity ids via a deterministic mapping.

## От чего зависит

Зависит от [`domainDocState`](#domaindocstate) и [`tierDocPathForEntity`](#tierdocpathforentity) — оба определены в этом же файле и используются для построения скелета документа.

## Чего не делает

Функция не выполняет никакой проверки на дубликаты или самоссылки — она просто строит скелет на основе переданного массива сущностей, не анализируя их содержимое.

# domainDocPath

```ts
domainDocPath(slug: string): string
```

## От чего зависит

Функция не вызывает tierDocPathForEntity.

## Кто и как использует

Используется для получения пути к документу каждой сущности, чтобы затем загрузить существующее состояние документа и сохранить обновленный скелет.

## Чего не делает

Функция не проверяет существование файла по возвращаемому пути — она просто вычисляет путь на основе имени сущности.

# projectDocPath

```ts
projectDocPath(): string
```

## Кто и как использует

Вызывается tierDocPathForEntity при entity.type === 'project'.

## Чего не делает

Функция возвращает константу, не обрабатывая имя проекта.

# tierDocPathForEntity

```ts
tierDocPathForEntity(entity: CodeEntity): string | undefined
```

## От чего зависит

Зависит от projectDocPath и domainDocPath.

## Кто и как использует

Используется для получения пути к документу каждой сущности, чтобы затем загрузить существующее состояние документа и сохранить обновленный скелет.

## Чего не делает

Функция не проверяет корректность имени сущности, хотя сама не конкатенирует строки — делегирует другим функциям.

## Как менять и что проверять

При изменении структуры путей к документам необходимо обновить эту функцию, так как она используется в [`buildDomainSkeletons`](#builddomainskeletons).

# domainDocState

```ts
domainDocState(entity: CodeEntity): DocState
```

## От чего зависит

Импортирует DOC_STATE_VERSION, anchorForHeading, orderBlocks и вызывает tierDocPathForEntity и tierHeading.

## Кто и как использует

Используется для загрузки существующего состояния документа и сохранения обновленного скелета.

## Чего не делает

Тип не включает поле `memberDocsFingerprint` в обязательные поля — оно опционально, что позволяет сохранять его только при наличии.

## Как менять и что проверять

При изменении структуры документа (например, добавлении нового поля) необходимо обновить все места, где создается или читается `domainDocState`, включая [`buildDomainSkeletons`](#builddomainskeletons).

# buildDomainSkeletons

```ts
buildDomainSkeletons(entities: Record<string, CodeEntity>): Map<string, DocState>
```

## Зачем это нужно

The function builds the initial skeleton structure for each entity's domain doc, including the ordered list of section ids, so that the preparation flow can later fill in section bodies.

## От чего зависит

Использует [`domainDocState`](#domaindocstate) для создания структуры документа и [`tierDocPathForEntity`](#tierdocpathforentity) для вычисления пути к файлу документа для каждой сущности.

## Кто и как использует

Вызывается из [`CodeloreService.prepareDomainDocs`](codelore-service.codelore.md#codeloreservicepreparedomaindocs) после перестройки индексов. Функция получает массив сущностей из индекса и для каждой создает скелет документа, который затем сохраняется через `docStateStorage.saveDocState`.

## Чего не делает

Функция не проверяет, существует ли уже документ по вычисленному пути — она всегда создает новый скелет, а проверка наличия выполняется позже в [`prepareDomainDocs`](codelore-service.codelore.md#codeloreservicepreparedomaindocs).

## Как менять и что проверять

При изменении порядка секций в скелете необходимо обновить `sectionOrder` в возвращаемом объекте, так как вызывающий код ([`prepareDomainDocs`](codelore-service.codelore.md#codeloreservicepreparedomaindocs)) полагается на этот порядок для сохранения предыдущих тел блоков.
