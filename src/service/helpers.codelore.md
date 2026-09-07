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

## Зачем это нужно

Находит первое повторяющееся значение в массиве строк.

## Что делает

- Принимает массив строк.
- Возвращает первую строку, которая встречается во второй раз, или `undefined` при отсутствии дубликатов.
- Не изменяет исходный массив.

## На что можно положиться

Возвращает `undefined` для пустого массива или массива без дубликатов.

## Кто и как использует

Вызывается в [`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections) для проверки дубликатов `sectionId` во входном массиве. Если `firstDuplicate` возвращает строку, выбрасывается ошибка с кодом `DUPLICATE_SECTION`.

## Чего не делает

Работает только с массивами строк — тип `string[]` задан сигнатурой. Не различает `undefined` и отсутствие дубликатов: возвращает `undefined` в обоих случаях.

## Как менять и что проверять

- Поиск дубликата останавливается на первом повторении через `seen.has(value)` — если нужно найти все дубликаты, потребуется другой алгоритм. Тест: не указан.
- Функция возвращает `undefined` при отсутствии дубликатов — вызывающий ([`CodeloreService.rewriteSections`](codelore-service.codelore.md#rewritesections)) проверяет результат через `if (duplicateSectionId)`, что корректно обрабатывает `undefined`. Тест: не указан.

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

## Зачем это нужно

Группирует элементы массива по строковому ключу, возвращая Map с группами.

## Что делает

- Не изменяет исходный массив.
- Не обрабатывает null/undefined ключи — keyForItem должна возвращать строку.

## На что можно положиться

- Возвращает Map с ключами в порядке первого появления.
- Пробрасывает исключения из keyForItem.

## Кто и как использует

Вызывается в `CodeloreService.applyTombstones` для группировки записей `StaleBlockInfo` по `docPath` перед итерацией по файлам. Вызывается в [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для группировки сущностей по `entity.path` перед созданием секций для каждого файла. Вызывается в [`CodeloreService.recordDepDocsFingerprints`](codelore-service.codelore.md#recorddepdocsfingerprints) для группировки записей о записанных секциях по `docPath` перед обновлением отпечатков зависимостей.

## Чего не делает

Не обрабатывает `null` или `undefined` ключи — `keyForItem` должна возвращать строку. Порядок элементов внутри групп соответствует исходному порядку элементов массива.

## Как менять и что проверять

1. Порядок ключей в возвращаемой `Map` соответствует порядку первого появления в массиве — это обеспечивается итерацией `for (const item of items)` и проверкой `groups.get(key) ?? []`. Тест: не указан.
2. Функция не мутирует исходный массив — она только читает его через `for (const item of items)`. Тест: не указан.

# isKnownBlockId

## Зачем это нужно

Проверяет, является ли строка известным идентификатором блока документации.

## Что делает

- Возвращает `true` только для значений, присутствующих в константном массиве `BLOCK_IDS`.
- При возврате `true` сужает тип аргумента до `BlockId` (type predicate).
- Не имеет побочных эффектов и не выбрасывает исключений.

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
