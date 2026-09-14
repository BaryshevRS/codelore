# rangesOverlap

## Зачем это нужно

Проверяет пересечение двух отрезков на числовой оси.

## Что делает

- Принимает четыре числа: начало и конец каждого отрезка.
- Возвращает `true`, если отрезки пересекаются хотя бы в одной точке.
- Не проверяет корректность порядка (может работать с `leftStart > leftEnd`).

## На что можно положиться

Возвращает `true` при касании отрезков в точке (включительно).

## Кто и как использует

Вызывается в `CodeloreService.changedEntitiesFromDiff` для каждого файла из `parseUnifiedDiff(diff)`. Для каждой сущности в файле проверяет, пересекается ли диапазон строк изменений (`range.startLine`, `range.endLine`) с диапазоном сущности (`entity.range.startLine`, `entity.range.endLine`). Если `rangesOverlap` возвращает `true`, идентификатор сущности добавляется в набор изменённых.

## Чего не делает

Не проверяет корректность порядка аргументов: отрезок может быть задан с `leftStart > leftEnd`, что даёт неверный результат пересечения.

# uniqueSorted

## Зачем это нужно

Удаляет дубликаты из массива строк и сортирует результат.

## Что делает

- Принимает массив строк.
- Возвращает новый массив без дубликатов, отсортированный по алфавиту.
- Не изменяет исходный массив.

## На что можно положиться

Результат отсортирован через `Array.sort()` (лексикографически).

## Кто и как использует

Вызывается в шести местах:
1. [`CodeloreService.analyzeChange`](codelore-service.codelore.md#analyzechange) — для объединения `input.changedFiles` с путями из `parseUnifiedDiff(diff)`.
2. `CodeloreService.changedEntitiesFromFiles` — для дедупликации и сортировки идентификаторов сущностей из `index.code.fileToEntities`.
3. [`docStateSectionForPlannedEntity`](prepare-docs.codelore.md#docstatesectionforplannedentity) — для сортировки `entity.directDeps` и `entity.directUsages`.
4. [`normalizePrepareScope`](prepare-docs.codelore.md#normalizepreparescope) — для дедупликации и сортировки `paths`, `files` и `entityIds`.
5. [`skippedPreparedDocSection`](prepare-docs.codelore.md#skippedprepareddocsection) — для сортировки `docPaths`.
6. [`mergeGeneratedBlocksIntoSection`](section-rewrite.codelore.md#mergegeneratedblocksintosection) — для сортировки `owner.directDeps` и `owner.directUsages`.

## Чего не делает

Работает только с массивами строк — тип `string[]` задан сигнатурой. Сортировка выполняется через `Array.sort()` без компаратора, что даёт лексикографический порядок, не подходящий для чисел.

# uniqueEntities

## Зачем это нужно

Удаляет дубликаты сущностей по их идентификатору и сортирует результат.

## Что делает

- Принимает массив `CodeEntity`.
- Возвращает новый массив без дубликатов, отсортированный по `entity.id`.
- Не изменяет исходный массив.

## На что можно положиться

Результат отсортирован через `left.id.localeCompare(right.id)`.

## Кто и как использует

Вызывается в [`CodeloreService.getSectionContext`](codelore-service.codelore.md#getsectioncontext) для дедупликации и сортировки массива `directUsages`. Для каждой сущности из `owns` собираются идентификаторы использований, затем по ним извлекаются объекты `CodeEntity` из `index.code.entities`, и результат передаётся в `uniqueEntities`.

## Чего не делает

Сортировка выполняется через `left.id.localeCompare(right.id)` — только по идентификатору, не по другим полям `CodeEntity`.

## Как менять и что проверять

- Дедупликация использует `seen.has(entity.id)` — идентификатор считается уникальным ключом. Если две сущности имеют одинаковый `id`, но разные другие поля, вторая будет отброшена. Тест: не указан.
- Сортировка выполняется через `left.id.localeCompare(right.id)` — порядок зависит от локали. Если требуется стабильный порядок по другому полю (например, `name`), нужно заменить компаратор. Тест: не указан.

# firstDuplicate

```ts
firstDuplicate(values: string[]): string | undefined
```

## Зачем это нужно

Находит первое повторяющееся значение в массиве строк.

## Что делает

- Принимает массив строк.
- Возвращает первую строку, которая встречается во второй раз, или `undefined` при отсутствии дубликатов.
- Не изменяет исходный массив.

## На что можно положиться

Возвращает `undefined` для пустого массива или массива без дубликатов.

## От чего зависит

Функция не импортирует никаких внешних модулей — использует только встроенный `Set` из стандартной библиотеки JavaScript.

## Кто и как использует

Вызывается в [`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections) (`src/service/codelore-service.ts`): метод создаёт массив `sectionId` через `sections.map(s => s.sectionId)` и передаёт его `firstDuplicate`. Если функция возвращает строку (обнаружен дубликат), вызывающий выбрасывает `new CodeloreError("DUPLICATE_SECTION", ...)` с кодом `DUPLICATE_SECTION` и идентификатором дубликата в деталях. При `undefined` выполнение продолжается к нормализации секций.

## Чего не делает

Сигнатура `values: string[]` ограничивает входной тип строками — функция не примет массив других типов. Кроме того, возвращает `undefined` как для пустого массива, так и для массива без дубликатов, что не позволяет различить эти два случая по возвращаемому значению. Однако вызывающий код ([`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections)) интерпретирует `undefined` одинаково (отсутствие дубликата), поэтому на практике ограничение не проявляется.

## Как менять и что проверять

- Поиск дубликата прекращается при первом совпадении: `if (seen.has(value)) { return value; }` — остальные значения массива не проверяются, итерация завершается.
- При отсутствии дубликатов функция завершается `return undefined` после цикла. Вызывающий ([`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections)) обрабатывает `undefined` как отсутствие дубликата.

# summarizeCodeEntity

## Зачем это нужно

Преобразует полную сущность кода в краткое представление для контекста секции.

## Что делает

- Принимает `CodeEntity`.
- Возвращает `CodeEntitySummary` с выбранными полями.
- Вычисляет `directDepCount` и `directUsageCount` как длины массивов зависимостей и использований.

## На что можно положиться

Всегда возвращает объект с теми же ключами, что и `CodeEntitySummary`.

## Кто и как использует

Вызывается в двух местах:
1. [`CodeloreService.getSectionContext`](codelore-service.codelore.md#getsectioncontext) — для преобразования сущностей `owns`, `depends` и `directUsages` в краткое представление.
2. [`buildRewriteContextBundle`](stale-detection.codelore.md#buildrewritecontextbundle) — для преобразования сущностей `owns` в контекст для перезаписи.

## Чего не делает

Не копирует поля `directDeps` и `directUsages` — вместо этого вычисляет их длины (`entity.directDeps.length`, `entity.directUsages.length`).

# summarizeDocSection

## Зачем это нужно

Преобразует полную секцию документации в краткое представление для контекста.

## Что делает

- Принимает `DocSection`.
- Возвращает объект с типом `SectionContext["section"]`.
- Трансформирует каждый блок секции, сохраняя все его поля.

## На что можно положиться

Количество блоков в результате совпадает с количеством блоков во входной секции.

## Кто и как использует

Вызывается в [`CodeloreService.getSectionContext`](codelore-service.codelore.md#getsectioncontext) для преобразования полной секции документации в краткое представление, которое включается в возвращаемый `SectionContext`.

## Чего не делает

Не фильтрует и не трансформирует содержимое блоков — копирует все поля каждого блока, включая `staleSince`, `staleReason`, `staleFacets`.

# groupBy

```ts
groupBy(items: T[], keyForItem: (item: T) => string): Map<string, T[]>
```

## Зачем это нужно

Группирует элементы массива по строковому ключу, возвращая Map с группами.

## Что делает

- Принимает массив элементов и функцию извлечения ключа, возвращает Map, где каждый ключ сопоставлен с массивом элементов, имеющих этот ключ.
- Для каждого элемента вычисляет ключ через `keyForItem` и добавляет элемент в соответствующую группу, создавая новую группу при первом появлении ключа.
- Порядок ключей в Map соответствует порядку первого появления элемента с этим ключом в исходном массиве — это обеспечивается конструкцией `groups.set(key, group)` при первом обращении к ключу.
- Каждый элемент попадает ровно в одну группу, так как функция не удаляет и не переносит элементы между группами.

## На что можно положиться

- Возвращает Map с ключами в порядке первого появления.
- Пробрасывает исключения из keyForItem.

## Кто и как использует

Вызывается в `CodeloreService.applyTombstones` для группировки записей `StaleBlockInfo` по `docPath` перед итерацией по файлам. Вызывается в [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для группировки сущностей по `entity.path` перед созданием секций для каждого файла. Вызывается в [`CodeloreService.recordDepDocsFingerprints`](codelore-service.codelore.md#recorddepdocsfingerprints) для группировки записей о записанных секциях по `docPath` перед обновлением отпечатков зависимостей.

## Чего не делает

Не обрабатывает `null` или `undefined` ключи — `keyForItem` должна возвращать строку. Порядок элементов внутри групп соответствует исходному порядку элементов массива.

## Как менять и что проверять

- The grouping key is derived by calling `keyForItem` on each item; items yielding the same string are collected into one array under that key.
- The returned Map preserves insertion order of keys: the first key encountered becomes the first entry, and subsequent keys append in encounter order.
- Each group is a fresh array; the original `items` array is not mutated, and the Map does not alias the input array.

# isKnownBlockId

```ts
isKnownBlockId(value: string): value is BlockId
```

## Зачем это нужно

Проверяет, является ли строка известным идентификатором блока документации.

## Что делает

- Проверяет, содержится ли переданная строка в фиксированном наборе допустимых идентификаторов блоков (`BLOCK_IDS`).
- При возврате `true` выполняет роль type predicate, сужая тип аргумента до `BlockId`.

## На что можно положиться

- Результат зависит только от значения value и константы BLOCK_IDS.
- Не имеет побочных эффектов.

## От чего зависит

`BLOCK_IDS` (`../markdown/block-ids.js`) — константный массив всех допустимых идентификаторов блоков документации.

## Кто и как использует

Вызывается в [`detectStaleBlocks`](doc-validation.codelore.md#detectstaleblocks) для фильтрации блоков секции перед проверкой на устаревание. Вызывается в [`addTargetBlock`](stale-detection.codelore.md#addtargetblock) для проверки валидности идентификатора блока перед добавлением в карту целей. Вызывается в [`collectDepDocStaleBlocks`](stale-detection.codelore.md#collectdepdocstaleblocks) для фильтрации блоков при обнаружении устаревших из-за изменений в документации зависимостей. Вызывается в [`deletedOwnedEntityBlocks`](stale-detection.codelore.md#deletedownedentityblocks) для фильтрации блоков при обнаружении удалённых сущностей. Вызывается в [`staleBlockInfoFor`](stale-detection.codelore.md#staleblockinfofor) для проверки идентификатора блока перед вычислением отпечатка. Вызывается в [`tombstonedBlockInfoFor`](stale-detection.codelore.md#tombstonedblockinfofor) для проверки идентификатора блока перед формированием информации о захороненном блоке.

## Чего не делает

Не проверяет, что значение является строкой — TypeScript гарантирует тип на этапе компиляции. Не проверяет регистр — сравнение чувствительно к регистру, так как `BLOCK_IDS` содержит точные значения.

# describeError

## Зачем это нужно

Нормализует неизвестное значение ошибки в структурированный объект с сообщением и опциональным кодом.

## Что делает

- Для CodeloreError извлекает message и code.
- Для остальных Error возвращает message; для не-Error — String(error).
- Не бросает исключений.

## На что можно положиться

- Всегда возвращает объект с полем error типа string.
- Поле code присутствует только если error является CodeloreError.

## Кто и как использует

Вызывается в [`CodeloreService.runPipelineForSections`](codelore-service.codelore.md#runpipelineforsections) при обработке отклонённых промисов и исключений в фазе `apply` — результат добавляется в массив `failed` с полями `error` и `code`.

## Чего не делает

Не извлекает `stack` — возвращает только сообщение и опциональный код. Для не-`Error` значений использует `String(error)`, что может дать неинформативное сообщение (например, `[object Object]`).
