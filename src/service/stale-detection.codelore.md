# targetBlocksFromTombstones

```ts
targetBlocksFromTombstones(tombstoned: Array<{ sectionId: string; blockId: string }>): Map<string, BlockId[]>
```

## Зачем это нужно

Преобразует массив записей о "похороненных" блоках в карту, группируя идентификаторы блоков по идентификатору секции для последующей перезаписи.

## Что делает

- Перебирает переданные записи tombstoned.
- Делегирует вставку в карту функции [`addTargetBlock`](#addtargetblock).
- Возвращает новую `Map` — не мутирует внешнее состояние.

## На что можно положиться

- Каждый раздел сопоставляется с массивом уникальных `BlockId` (дубликаты не допускаются).
- Неизвестные идентификаторы блоков молча пропускаются через [`addTargetBlock`](#addtargetblock).

## От чего зависит

- Uses a function from [`src/service/helpers.ts`](helpers.codelore.md) to check whether a block ID is known.
- Operates on `BlockId` type imported from `../markdown/block-ids.js`.

## Кто и как использует

Вызывается из [`CodeloreService.fixStaleDocs`](codelore-service.codelore.md#fixstaledocs) для преобразования массива `tombstoned` (списка похороненных блоков) в карту `Map<sectionId, BlockId[]>`. Каждая запись передаётся в [`addTargetBlock`](#addtargetblock), которая вставляет идентификатор блока в карту или пропускает неизвестные блоки. Результат используется для генерации документации только целевых блоков.

# addTargetBlock

```ts
addTargetBlock(targets: Map<string, BlockId[]>, sectionId: string, blockId: string): void
```

## Зачем это нужно

Добавляет идентификатор блока в список указанного раздела внутри карты целей, исключая дубликаты и неизвестные блоки.

## Что делает

The function records a block as a target only when it is a known block ID — otherwise it silently skips the entry. It mutates the provided targets map in place, appending the blockId to the array for the given sectionId, creating the array if absent. It does not validate the sectionId or blockId beyond the known-ID check, and it does not return any value or signal whether the entry was added.

## На что можно положиться

- Если `blockId` не является известным идентификатором блока, функция ничего не делает.
- После вызова `targets` для данного раздела будет содержать `blockId` не более одного раза.

## От чего зависит

- Uses [`isKnownBlockId`](helpers.codelore.md#isknownblockid) from `src/service/helpers.ts` to check whether a block ID is known.
- Operates on `BlockId` type imported from `../markdown/block-ids.js`.

## Кто и как использует

- Called by [`CodeloreService.generateDocsForScope`](codelore-service.codelore.md#generatedocsforscope) to add target blocks for scoped sections.
- Called by [`CodeloreService.queueUnwrittenBlocks`](codelore-service.codelore.md#codeloreservicequeueunwrittenblocks) to add target blocks for unwritten blocks.

## Чего не делает

- The function does not validate the sectionId or blockId beyond the known-ID check, and it does not return any value or signal whether the entry was added.

## Как менять и что проверять

- The function enforces that only known block IDs are added to the target set, via the guard `if (!isKnownBlockId(block.id) || block.staleSince !== undefined || block.body.trim() === "")`.
- The function enforces that blocks with a `staleSince` timestamp or an empty body are skipped, via the same guard expression.

# filterSectionsByScope

```ts
filterSectionsByScope(sections: DocSection[], scope: RefreshStaleScope | undefined, entities: Record<string, CodeEntity>): DocSection[]
```

## Зачем это нужно

Отфильтровывает секции документации, соответствующие заданной области видимости (идентификаторы секций, пути файлов или префиксы путей).

## Что делает

- The function filters sections by two independent rules: a section is kept when its ID is in the scope's section set (`sectionIds.has(section.id)`), or when its owning entity path matches one of the scope's paths.
- The path match accepts both an exact equality (`path === prefix`) and a prefix relationship (`path.startsWith(`${prefix}/`)`), so a section whose entity lives under a scope-owned directory is included.
- The function relies on the scope's `sectionIds` and `paths` fields; when the scope is undefined, the function returns all sections unchanged.

## На что можно положиться

- Возвращает новый массив — исходный `sections` не мутируется.
- Секция считается подходящей, если путь хотя бы одной из её принадлежащих сущностей совпадает с файлом из `scope.files` или начинается с любого префикса из `scope.paths`.

## От чего зависит

[`sourcePathFromEntityId`](#sourcepathfromentityid) (из того же файла) — извлекает путь к файлу из идентификатора сущности для сопоставления с `scope.files` и `scope.paths`.

## Кто и как использует

Вызывается из [`CodeloreService.refreshStaleDocs`](codelore-service.codelore.md#refreshstaledocs) для ограничения набора секций документации переданным scope. Применяет три проверки: совпадение по `sectionId`, по пути файла принадлежащей сущности в `scope.files`, по префиксу пути в `scope.paths`. Возвращает отфильтрованный массив.

## Чего не делает

Сопоставление по пути файла зависит от [`sourcePathFromEntityId`](#sourcepathfromentityid), который поддерживает только идентификаторы с префиксами `file:` и `symbol:`; сущности с другими префиксами не участвуют в фильтрации.
Проверка по префиксам выполняется через `path === prefix || path.startsWith(prefix + "/")` — не учитывает регистр и не нормализует разделители путей.

## Как менять и что проверять

- The function enforces that a section is included only when its owning entity path matches one of the scope's owned paths, via the expression `ownedPaths.some((path) => files.has(path))` and the prefix check `path.startsWith(`${prefix}/`)`.
- The function enforces that a section is included only when its section ID is in the scope's section set, via the check `sectionIds.has(section.id)`.

# sourcePathFromEntityId

## Зачем это нужно

Извлекает путь к файлу из строки идентификатора сущности для префиксов `file:` и `symbol:`.

## Что делает

- Для префикса `file:` возвращает всё, что после `file:`.
- Для префикса `symbol:` извлекает часть до разделителя `#`.
- Возвращает `undefined` для любого другого префикса.

## На что можно положиться

- Возвращает `undefined`, если идентификатор сущности не начинается с `file:` или `symbol:`.
- Для `symbol:` возвращает `undefined`, если часть пути пуста.

## Кто и как использует

Вызывается из [`filterSectionsByScope`](#filtersectionsbyscope) для извлечения пути файла из идентификатора сущности при отсутствии прямого поля `path`. Также используется в рантайме модулями `code-indexer`, `doc-validator` и `file-pipeline` для обратного преобразования идентификаторов (`file:`, `symbol:`) в путь к файлу.

## Чего не делает

Обрабатывает только идентификаторы с префиксами `file:` и `symbol:`; для всех остальных возвращает `undefined`.
Для `symbol:` извлекает путь как часть до первого символа `#` — не подходит, если в пути содержится `#` (маловероятно для файловых путей).

# collectDepDocStaleBlocks

```ts
collectDepDocStaleBlocks(sections: DocSection[], index: ProjectIndex): StaleBlockInfo[]
```

## Зачем это нужно

Обнаруживает секции, чья документация зависимостей изменилась, что приводит к устареванию непропагирующих блоков.

## Что делает

- Пропускает секции без сохранённого `depDocsFingerprint` — они исключаются из рассмотрения.
- Вычисляет текущий отпечаток через `dependencyDocsFingerprint(collectDependencyDocs(index, [file]))`, беря путь файла из первой owned-сущности секции, и кэширует результат в `fingerprintByFile`, чтобы не пересчитывать его для нескольких секций одного файла.
- При расхождении текущего и сохранённого отпечатков помечает каждый известный, непустой, ещё не устаревший блок секции записью с `changedFacets: ["depDocs"]` и `drift: "facet_changed"`.
- Исключает пропагирующие блоки (`PROPAGATING_BLOCKS`): они генерируются без dependency docs, поэтому не могут устареть по этой причине.

## На что можно положиться

- Каждая секция порождает не более одной записи об устаревании на блок.
- Пропагирующие блоки (`PROPAGATING_BLOCKS`) никогда не считаются устаревшими из-за изменения зависимостей.

## От чего зависит

[`collectDependencyDocs`](../llm/file-pipeline.codelore.md#collectdependencydocs) (`src/llm/file-pipeline.ts`) — собирает документацию прямых зависимостей для файла.
[`dependencyDocsFingerprint`](../llm/file-pipeline.codelore.md#dependencydocsfingerprint) (`src/llm/file-pipeline.ts`) — вычисляет SHA-256 хеш документации зависимостей.
[`isKnownBlockId`](helpers.codelore.md#isknownblockid) (`./helpers.ts`) — проверяет, что идентификатор блока является известным.
`PROPAGATING_BLOCKS` ([`src/llm/file-pipeline.ts`](../llm/file-pipeline.codelore.md)) — константа со списком блоков, которые не зависят от документации зависимостей.

## Кто и как использует

Вызывается из `CodeloreService.refreshStaleDocs`. Перебирает секции, для каждой с сохранённым `depDocsFingerprint` вычисляет текущий отпечаток и сравнивает. Если отпечаток изменился, помечает все непустые, не-пропагирующие блоки, которые ещё не помечены как устаревшие, как устаревшие с фасетом `depDocs`.

## Чего не делает

Учитывает только первую принадлежащую сущность секции (`section.owns[0]`) для получения пути файла — если секция владеет несколькими файлами, зависимые документы собираются только по первому.
Блоки с пустым телом (`block.body.trim() === ""`) или уже устаревшие (`block.staleSince !== undefined`) пропускаются, даже если depDocs изменились.

## Как менять и что проверять

- Отпечаток документации зависимостей пересчитывается не чаще одного раза на файл: перед расчётом код проверяет кэш через `fingerprintByFile.get(file)`, а после — сохраняет результат через `fingerprintByFile.set(file, current)`.
- В запись об устаревании попадают только известные, непустые и ещё не похороненные блоки: `if (!isKnownBlockId(block.id) || block.staleSince !== undefined || block.body.trim() === "") { continue; }`.
- Совпадение текущего и сохранённого отпечатков досрочно завершает обработку секции: `if (current === section.depDocsFingerprint) { continue; }`.

# mergeStaleBlocks

```ts
mergeStaleBlocks(...passes: StaleBlockInfo[][]): StaleBlockInfo[]
```

## Зачем это нужно

Объединяет несколько проходов обнаружения устаревших блоков в единый список, устраняя дубликаты и объединяя изменившиеся фасеты.

## Что делает

- Схлопывает записи из разных проходов по составному ключу `sectionId + "\u0000" + blockId`: первая запись пары сохраняется целиком.
- При повторном вхождении той же пары объединяет `changedFacets` в union через `Set`, остальные поля первой записи не меняет.
- Возвращает новый массив значений Map, не мутируя входные массивы проходов.

## На что можно положиться

- Возвращает новый массив — исходные массивы не мутируются.
- Каждая результирующая запись уникальна для пары (sectionId, blockId).

## Кто и как использует

Вызывается из `CodeloreService.refreshStaleDocs` для объединения устаревших блоков, устраняя дубликаты по составному ключу `sectionId + '\\u0000' + blockId`, и объединяя массивы `changedFacets` при повторных вхождениях.

## Чего не делает

Ключ дедупликации строится через конкатенацию с нуль-символом (`\u0000`) — предполагается, что ни `sectionId`, ни `blockId` не содержат нуль-символов.
Объединение `changedFacets` выполняется только для первой встреченной записи; все остальные поля (например, `drift`, `docPath`) остаются от первой записи.

## Как менять и что проверять

- Ключ дедупликации склеивает sectionId и blockId нуль-символом, чтобы граница между ними не терялась: `` `${entry.sectionId}\u0000${entry.blockId}` ``.
- Первая встреченная запись для пары сохраняется целиком, повторные вхождения лишь пополняют её `changedFacets` через `existing.changedFacets = [...new Set([...existing.changedFacets, ...entry.changedFacets])];`, поэтому `drift` и `docPath` всегда берутся из первого прохода.

# collectStaleBlocks

```ts
collectStaleBlocks(sections: DocSection[], entities: Record<string, CodeEntity>): StaleBlockInfo[]
```

## Зачем это нужно

Обнаруживает устаревшие блоки документации.

## Что делает

- Для секций, у которых хотя бы одна owned-сущность присутствует в `entities`, делегирует проверку каждого блока в [`staleBlockInfoFor`](#staleblockinfofor).
- Для секций, потерявших все owned-сущности, делегирует [`deletedOwnedEntityBlocks`](#deletedownedentityblocks), которая помечает все известные непустые блоки с `drift: "owned_entity_deleted"`.
- Возвращает плоский массив записей, не мутируя переданные секции и сущности.

## На что можно положиться

- Каждый элемент возвращаемого массива имеет `drift` равный `"facet_changed"` (если получен от [`staleBlockInfoFor`](#staleblockinfofor)) или `"owned_entity_deleted"` (от [`deletedOwnedEntityBlocks`](#deletedownedentityblocks)).
- Не включает блоки с пустым телом, неизвестным идентификатором или уже установленным `staleSince`.
- Функция чистая — не мутирует аргументы.

## От чего зависит

- [`deletedOwnedEntityBlocks`](#deletedownedentityblocks) (`src/service/stale-detection.ts`) — формирует записи для секций, все owned-сущности которых удалены.
- [`staleBlockInfoFor`](#staleblockinfofor) (`src/service/stale-detection.ts`) — проверяет отдельный блок на изменение отпечатка.

## Кто и как использует

Вызывается из `CodeloreService.refreshStaleDocs` ([`src/service/codelore-service.ts`](codelore-service.codelore.md#codelore-servicets)) после фильтрации секций по scope.
1. Для каждой секции фильтруются owned-сущности, присутствующие в `entities`.
2. Если ни одна owned-сущность не найдена, вызывается [`deletedOwnedEntityBlocks`](#deletedownedentityblocks).
3. Иначе для каждого блока секции вызывается [`staleBlockInfoFor`](#staleblockinfofor).

## Чего не делает

Не проверяет блоки с уже установленным `staleSince` — они считаются похороненными.

## Как менять и что проверять

- Секция переходит в ветку удаления владельцев только когда `presentOwns.length === 0`, где `presentOwns` получен фильтром `section.owns.filter((id) => entities[id])`; при частичной потере владельцев блоки по-прежнему проверяются по отпечаткам.
- Решение по каждому блоку целиком делегировано [`staleBlockInfoFor`](#staleblockinfofor), и в результат попадает только его непустой возврат: `const info = staleBlockInfoFor(section, block, presentOwns, entities); if (info) { stale.push(info); }`.

# collectTombstonedBlocks

```ts
collectTombstonedBlocks(sections: DocSection[], entities: Record<string, CodeEntity>): StaleBlockInfo[]
```

## Зачем это нужно

Выявляет блоки, уже отмеченные как «похороненные» (имеющие `staleSince`).

## Что делает

- Для секций с живыми owned-сущностями делегирует [`tombstonedBlockInfoFor`](#tombstonedblockinfofor), который возвращает запись только для блоков с установленным `staleSince` и непустым телом.
- Для секций без owned-сущностей делегирует [`deletedOwnedEntityBlocks`](#deletedownedentityblocks) с `tombstonedOnly: true`, включая только уже похороненные блоки.
- Возвращает записи с `drift: "tombstoned"`; фасеты берёт из сохранённого `staleFacets` блока, а при его отсутствии — из `BLOCK_FACETS[block.id]`.
- Не вычисляет отпечатки и не обращается к коду сущностей — работает только по метаданным блоков.

## На что можно положиться

- Все возвращённые записи имеют `drift: "tombstoned"`.
- Изменённые фасеты берутся из поля `staleFacets` блока, если оно есть, иначе из `BLOCK_FACETS[block.id]`.
- Не изменяет состояние.

## От чего зависит

- [`deletedOwnedEntityBlocks`](#deletedownedentityblocks) (`src/service/stale-detection.ts`) — формирует записи для секций без owned-сущностей, с опцией `tombstonedOnly: true`.
- [`tombstonedBlockInfoFor`](#tombstonedblockinfofor) (`src/service/stale-detection.ts`) — извлекает информацию о похороненном блоке из его метаданных.

## Кто и как использует

Вызывается из `CodeloreService.refreshStaleDocs` ([`src/service/codelore-service.ts`](codelore-service.codelore.md#codelore-servicets)). Результат используется для формирования `rewritePlan` или для применения tombstone.
1. Для каждой секции фильтруются owned-сущности, присутствующие в `entities`.
2. Если ни одна owned-сущность не найдена, вызывается [`deletedOwnedEntityBlocks`](#deletedownedentityblocks) с `tombstonedOnly: true`.
3. Иначе для каждого блока секции вызывается [`tombstonedBlockInfoFor`](#tombstonedblockinfofor).

## Чего не делает

Не проверяет блоки без `staleSince` — они считаются свежими.

## Как менять и что проверять

- В ветке секций без живых владельцев отбираются только уже похороненные блоки, потому что опция передаётся явно: [`deletedOwnedEntityBlocks(section, { tombstonedOnly: true })`](#deletedownedentityblocks).
- Для секций с живыми владельцами решение по блоку делегировано [`tombstonedBlockInfoFor`](#tombstonedblockinfofor), и в результат попадает только его непустой возврат: `const info = tombstonedBlockInfoFor(section, block); if (info) { tombstoned.push(info); }`.

# deletedOwnedEntityBlocks

## Зачем это нужно

Формирует записи об устаревших блоках для секции, все принадлежащие сущности которой удалены.

## Что делает

- Обрабатывает все блоки секции, отфильтровывая неизвестные и пустые.
- Параметр `tombstonedOnly` управляет фильтрацией: если `false` (по умолчанию), включает только блоки без `staleSince` (свежие); если `true` — только блоки с `staleSince`.
- Для каждого подходящего блока создаёт `StaleBlockInfo` с `drift: "owned_entity_deleted"` и `changedFacets: ["owned"]`.
- Возвращает массив; может быть пустым, если ни один блок не соответствует условиям.

## На что можно положиться

- Для каждого возвращённого элемента поле `changedFacets` всегда равно `["owned"]`.
- `drift` всегда `"owned_entity_deleted"`.
- Не проверяет наличие принадлежащих сущностей; полагается на вызывающего.

## От чего зависит

- [`isKnownBlockId`](helpers.codelore.md#isknownblockid) (`src/service/helpers.ts`) — проверяет, является ли идентификатор блока известным.

## Кто и как использует

Вызывается из [`collectStaleBlocks`](#collectstaleblocks) (с `tombstonedOnly: false`) и из [`collectTombstonedBlocks`](#collecttombstonedblocks) (с `tombstonedOnly: true`). Оба вызывающих передают секцию, у которой `presentOwns.length === 0`.
1. Перебирает все блоки секции.
2. Пропускает блоки с неизвестным ID или пустым телом.
3. Если `tombstonedOnly` не совпадает с наличием `staleSince`, блок пропускается.
4. Для подходящих блоков создаётся `StaleBlockInfo` с `drift: "owned_entity_deleted"`.

## Чего не делает

Не проверяет, действительно ли owned-сущности удалены — полагается на вызывающего, который уже отфильтровал `presentOwns`.

## Как менять и что проверять

- Если изменить условие `(block.staleSince !== undefined) !== (options.tombstonedOnly ?? false)`, изменится фильтрация tombstoned-блоков — тест `deletedOwnedEntityBlocks` должен покрывать оба режима.
- Если убрать проверку [`isKnownBlockId(block.id)`](helpers.codelore.md#isknownblockid), неизвестные blockId будут включены в результат — тест `deletedOwnedEntityBlocks` должен проверять фильтрацию неизвестных ID.

# staleReasonFor

## Зачем это нужно

Преобразует информацию о причине устаревания блока в короткую строку для сохранения в метаданных.

## Что делает

- Если поле `drift` равно `"owned_entity_deleted"`, возвращает точно `"owned_entity_deleted"`.
- Иначе, если `changedFacets` содержит ровно один элемент, возвращает строку вида `"<фасет>_changed"`; иначе возвращает `"code_changed"`.
- Не использует внешние зависимости; чистая функция.

## На что можно положиться

- Возвращаемая строка всегда непуста.
- Результат детерминирован относительно входных полей.

## От чего зависит

Нет внешних зависимостей.

## Кто и как использует

Вызывается из `CodeloreService.applyTombstones` ([`src/service/codelore-service.ts`](codelore-service.codelore.md#codelore-servicets)) для каждого stale-блока, чтобы получить строку причины для поля `staleReason`. Также используется в `staleValidationIssue` ([`src/service/doc-validation.ts`](doc-validation.codelore.md)) при формировании сообщения валидации — там литерал `"code_changed"` используется как fallback в шаблоне строки.

## Чего не делает

Не различает комбинации фасетов — при двух и более изменившихся фасетах всегда возвращает `"code_changed"`.

# staleBlockInfoFor

## Зачем это нужно

Определяет, изменился ли отпечаток отдельного блока по сравнению с сохранённым, и, если изменился, возвращает информацию о фасетах, которые стали неактуальны.

## Что делает

- Пропускает блоки с неизвестным ID, пустым телом или уже установленным `staleSince`.
- Вычисляет текущий отпечаток через [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint); если он `undefined`, возвращает `undefined`.
- Сравнивает текущий отпечаток с сохранённым (`section.blockFingerprints[block.id]`).
- Если отпечатки совпадают, возвращает `undefined`; иначе вычисляет изменившиеся фасеты через [`diffFacetHashes`](../markdown/block-facets.codelore.md#difffacethashes); если различие пусто, использует все фасеты для данного типа блока.
- Возвращает `StaleBlockInfo` с `drift: "facet_changed"`.

## На что можно положиться

- Не изменяет состояние.
- Для блоков, у которых отпечаток не изменился, возвращает `undefined`.

## От чего зависит

- [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) (`src/markdown/block-facets.ts`) — вычисляет текущий отпечаток блока.
- [`diffFacetHashes`](../markdown/block-facets.codelore.md#difffacethashes) (`src/markdown/block-facets.ts`) — определяет изменившиеся фасеты.
- [`parseBlockFingerprintValue`](../markdown/block-facets.codelore.md#parseblockfingerprintvalue) (`src/markdown/block-facets.ts`) — преобразует строку отпечатка в объект.
- [`isKnownBlockId`](helpers.codelore.md#isknownblockid) (`src/service/helpers.ts`) — проверяет известность идентификатора блока.

## Кто и как использует

Вызывается из [`collectStaleBlocks`](#collectstaleblocks) для каждого блока секции, у которой есть owned-сущности.
1. Пропускает блоки с неизвестным ID, пустым телом или `staleSince`.
2. Вычисляет текущий отпечаток через [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint).
3. Если отпечаток `undefined`, возвращает `undefined`.
4. Сравнивает с сохранённым отпечатком из `section.blockFingerprints`.
5. При несовпадении вычисляет изменившиеся фасеты через [`diffFacetHashes`](../markdown/block-facets.codelore.md#difffacethashes); если различие пусто, использует все фасеты для данного типа блока.

## Чего не делает

Не обрабатывает блоки с `staleSince` — они считаются похороненными.

## Как менять и что проверять

- Если изменить условие `block.staleSince !== undefined || block.body.trim() === ""`, блоки с пустым телом или staleSince будут включены в проверку — тест `staleBlockInfoFor` должен покрывать эти случаи.
- Если убрать вызов [`diffFacetHashes`](../markdown/block-facets.codelore.md#difffacethashes), все блоки с изменившимся отпечатком будут помечены как stale со всеми фасетами — тест `staleBlockInfoFor` должен проверять точность определения изменившихся фасетов.

# tombstonedBlockInfoFor

## Зачем это нужно

Извлекает информацию о похороненном блоке из его метаданных без сравнения с текущим кодом.

## Что делает

- Фильтрует блоки, у которых `staleSince` не установлен, тело пусто или ID неизвестен.
- Для подходящих блоков возвращает `StaleBlockInfo` с `drift: "tombstoned"`.
- Изменённые фасеты берутся из `block.staleFacets`, если есть, иначе из `BLOCK_FACETS[block.id]`.

## На что можно положиться

- Возвращает запись только для блоков с непустым `staleSince`.
- Не использует код сущностей или отпечатки.

## От чего зависит

- [`isKnownBlockId`](helpers.codelore.md#isknownblockid) (`src/service/helpers.ts`) — проверяет, является ли идентификатор блока известным.

## Кто и как использует

Вызывается из [`collectTombstonedBlocks`](#collecttombstonedblocks) для каждого блока секции, у которой есть owned-сущности.
1. Пропускает блоки с неизвестным ID, пустым телом или без `staleSince`.
2. Для подходящих блоков возвращает `StaleBlockInfo` с `drift: "tombstoned"`.
3. Изменённые фасеты берутся из `block.staleFacets`, если есть, иначе из `BLOCK_FACETS[block.id]`.

## Чего не делает

Не проверяет блоки без `staleSince` — они считаются свежими.

# buildRewriteContextBundle

## Зачем это нужно

Собирает из записи об устаревании и проектного индекса все данные, необходимые для последующей перезаписи блока: текущий текст, сводки владельцев и причину изменения.

## Что делает

* Извлекает секцию и блок из `index.docs.sections` по `entry.sectionId` и `entry.blockId`.
* Отбирает из `section.owns` только те сущности, которые присутствуют в `index.code.entities`, и для каждой вызывает [`summarizeCodeEntity`](helpers.codelore.md#summarizecodeentity).
* Собирает поля `RewritContextBundle`: `currentText`, `owns`, `changedFacets`, `reason`.
* Не выполняет саму перезапись — возвращает пакет для планировщика перезаписи.

## На что можно положиться

* Возвращаемый `reason` всегда составлен из `entry.changedFacets.join(', ')` и имён владельцев.
* Поле `owns` содержит только существующие сущности; отсутствующие в индексе отфильтрованы.

## От чего зависит

- [`summarizeCodeEntity`](helpers.codelore.md#summarizecodeentity) (`src/service/helpers.ts`) — преобразует `CodeEntity` в `CodeEntitySummary` для поля `owns`.

## Кто и как использует

Вызывается из [`CodeloreService.refreshStaleDocs`](codelore-service.codelore.md#refreshstaledocs) при `mode === "rewrite_plan"`. Для каждой записи из объединения `stale` и `tombstoned` создаёт `RewriteContextBundle`, который собирается в массив `rewritePlan` и возвращается в `RefreshStaleDocsResult.rewritePlan`.

# refreshStaleResult

## Зачем это нужно

Формирует итоговый результат операции обновления устаревшей документации по заданному режиму.

## Что делает

* Вычисляет поля `summary.stale`, `summary.tombstoned`, `summary.appliedTombstones` как длины переданных массивов.
* Включает поле `appliedTombstones` в результат только если `mode === 'tombstone'`.
* Передаёт `rewritePlan` в результат, если он передан; иначе поле отсутствует.
* Не модифицирует состояние индекса или хранилища — только упаковывает данные.

## На что можно положиться

* При `mode === 'tombstone'` в результате присутствует поле `appliedTombstones` с тем же массивом.

## От чего зависит

Нет зависимостей — функция использует только свои параметры.

## Кто и как использует

Вызывается из [`CodeloreService.refreshStaleDocs`](codelore-service.codelore.md#refreshstaledocs) в трёх ветках:
- Для `mode === "report"` — только с массивами `stale` и `tombstoned`.
- Для `mode === "rewrite_plan"` — с дополнительным массивом `rewritePlan`.
- Для `mode === "tombstone"` — с массивом `appliedTombstones`.
Возвращает `RefreshStaleDocsResult`.

## Чего не делает

Отсутствуют — функция не выполняет валидацию режима или массивов, передаёт данные без преобразования.

# collectLanguageStaleBlocks

```ts
collectLanguageStaleBlocks(sections: DocSection[], canonicalLanguage: string | undefined): StaleBlockInfo[]
```

## Зачем это нужно

Обнаруживает блоки документации, язык которых не соответствует текущему каноническому языку, чтобы отметить их как устаревшие для последующей регенерации.

## Что делает

- При `canonicalLanguage === undefined` сразу возвращает пустой массив — без канонического языка нечего сравнивать.
- Пропускает блоки с неизвестным id, уже устаревшие (`staleSince`), пустые и без языковой метки (`block.language === undefined`).
- Для каждого блока, чья метка `block.language` отличается от `canonicalLanguage`, создаёт запись с `changedFacets: ["language"]` и `drift: "facet_changed"`.

## На что можно положиться

- Возвращает пустой массив, если `canonicalLanguage` равен `undefined`.
- Флагирует только блоки, у которых `block.language` существует и не совпадает с `canonicalLanguage`.
- Не изменяет переданные секции и блоки, возвращая новые записи.

## От чего зависит

Функция использует [`isKnownBlockId`](helpers.codelore.md#isknownblockid) из `src/service/helpers.ts` для проверки, является ли идентификатор блока известным.

## Кто и как использует

Вызывается из `CodeloreService.refreshStaleDocs` с аргументом `this.config.docs.language` в качестве канонического языка. Функция последовательно обходит все секции и блоки, отфильтровывая блоки без языковой метки, и возвращает массив устаревших блоков для последующей обработки.

## Чего не делает

Функция не обрабатывает блоки, у которых отсутствует языковая метка (`block.language === undefined`) — такие блоки не считаются устаревшими, даже если канонический язык изменился. Это ограничение заложено в условии `continue` при `block.language === undefined`.

## Как менять и что проверять

- Языковая проверка стоит последней: блоки с неизвестным id, уже похороненные или пустые отсекаются раньше условием `if (!isKnownBlockId(block.id) || block.staleSince !== undefined || block.body.trim() === "") { continue; }`.
- Запись об устаревании всегда несёт ровно фасет `language` — он зафиксирован литералом `changedFacets: ["language"]`, а не вычислен из diff отпечатков.
