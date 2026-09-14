# validateOwnedEntities

## Зачем это нужно

Сигнализирует о секциях, которые ссылаются на несуществующие сущности в поле `owns`.

## Что делает

- Итерирует по `section.owns` и проверяет присутствие каждого идентификатора в `codeEntities`.
- Для каждого отсутствующего идентификатора возвращает `DocValidationIssue` с кодом `stale_owned_entity` и уровнем `error`.
- Не проверяет, является ли секция владельцем сущности по другим критериям (например, типу).

## На что можно положиться

Возвращает пустой массив, если все `section.owns` присутствуют в `codeEntities`. Не изменяет переданные объекты.

## От чего зависит

Не импортирует утилит из других модулей; использует только типы `DocSection`, `CodeEntity`, `DocValidationIssue` из `../types`.

## Кто и как использует

Вызывается из [`CodeloreService.validateDocs`](codelore-service.codelore.md#validatedocs). Метод перестраивает индексы, затем для каждой секции вызывает `validateOwnedEntities`, передавая секцию и словарь code-сущностей. Функция итерирует по `section.owns` и при отсутствии сущности в `codeEntities` формирует `DocValidationIssue` с кодом `stale_owned_entity` и уровнем `error`.

## Как менять и что проверять

1. Всегда возвращает пустой массив, если все `section.owns` присутствуют в `codeEntities` — конструкция: `if (!codeEntities[ownedEntityId])` добавляет issue только при отсутствии.
2. Не изменяет переданные объекты — единственная запись — `issues.push(...)`, цикл `for (const ownedEntityId of section.owns)` только читает поля.

# detectStaleBlocks

## Зачем это нужно

Возвращает предупреждения о блоках, содержимое которых расходится с текущим кодом, на основе сохранённых отпечатков.

## Что делает

- Пропускает секции без owned-сущностей в `section.owns`.
- Для каждого блока с известным `block.id` делегирует проверку в [`staleValidationIssue`](#stalevalidationissue).
- Не проверяет блоки, чей идентификатор не распознан [`isKnownBlockId`](helpers.codelore.md#isknownblockid).

## На что можно положиться

Возвращает пустой массив, если `section.owns` пуст или ни одна owned-сущность не найдена в `codeEntities`. Порядок элементов в результате соответствует порядку блоков в секции.

## От чего зависит

- [`isKnownBlockId`](helpers.codelore.md#isknownblockid) (`src/service/helpers.ts`) — проверяет, распознан ли идентификатор блока.
- [`staleValidationIssue`](#stalevalidationissue) (`src/service/doc-validation.ts`) — формирует issue для одного блока.

## Кто и как использует

Функция проверяет наличие owned-сущностей; при отсутствии возвращает пустой массив. Для каждого блока секции с известным `block.id` (проверка через [`isKnownBlockId`](helpers.codelore.md#isknownblockid)) делегирует проверку устаревания в [`staleValidationIssue`](#stalevalidationissue).

## Как менять и что проверять

1. При пустом `section.owns` или отсутствии owned-сущностей в `codeEntities` возвращает пустой массив — конструкция: `if (section.owns.length === 0) { return issues; }` и `if (presentOwns.length === 0) { return issues; }`.
2. Порядок issues соответствует порядку блоков — блоки обрабатываются в цикле `for (const block of section.blocks)`, issue добавляются в том же порядке.

# staleValidationIssue

```ts
staleValidationIssue(section: DocSection, block: DocSection["blocks"][number], blockId: BlockId, presentOwns: string[], codeEntities: Record<string, CodeEntity>): DocValidationIssue | undefined
```

## Зачем это нужно

Определяет, является ли один блок документации устаревшим, сравнивая текущий отпечаток с сохранённым.

## Что делает

- Вычисляет текущий отпечаток блока через [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) и сразу завершается, возвращая `undefined`, если отпечаток получить не удалось.
- Для блока со `staleSince` возвращает предупреждение с `drift: "tombstoned"`: изменённые фасеты берёт из `block.staleFacets`, а при их отсутствии подставляет весь `[...BLOCK_FACETS[blockId]]`, в сообщение включает причину `block.staleReason` (по умолчанию `"code_changed"`) и дату `staleSince`.
- Для остальных блоков при обнаруженном расхождении фасетов формирует предупреждение с `drift: "facet_changed"` и соответствующими фасетами.
- Когда расхождения нет — `currentValue === undefined` или расхождение не обнаружено — возвращает `undefined`.

## На что можно положиться

- Каждый возвращённый issue несёт `code: "stale_block"` и `severity: "warning"` — функция никогда не выдаёт ошибку, только предупреждение.
- Поле `drift` принимает ровно одно из двух значений: `"tombstoned"` для блока со `staleSince` либо `"facet_changed"` для расхождения фасетов.
- Сообщение для tombstoned-блока содержит причину `block.staleReason` (по умолчанию `"code_changed"`) и дату `staleSince`; для `facet_changed` — список фасетов, соединённый через `", "`.
- Функция не мутирует `section`, `block` и `codeEntities` — только читает их и создаёт новый issue.

## От чего зависит

Опирается на два модуля. [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) (src/markdown/block-facets.ts) вычисляет текущий отпечаток блока по фасетам владеющих сущностей; константа `BLOCK_FACETS` (src/markdown/block-facets.ts) даёт запасной набор фасетов для tombstoned-блока без `staleFacets`. [`staleBlockInfoFor`](stale-detection.codelore.md#staleblockinfofor) (src/service/stale-detection.ts) ищет изменившиеся фасеты для обычного блока и сообщает, есть ли расхождение.

## Кто и как использует

Вызывается из [`detectStaleBlocks`](#detectstaleblocks) в цикле по блокам секции. Тот отсекает пустые случаи: если `section.owns` пуст или ни одна owned-сущность не найдена в `codeEntities`, функция не вызывается, поэтому `presentOwns` всегда содержит хотя бы одну живую сущность; обрабатываются только известные блоки секции. Сама функция вычисляет отпечаток и при недоступном значении молча пропускает блок. Для блока с уже установленным `staleSince` строит предупреждение из метаданных блока; иначе спрашивает [`staleBlockInfoFor`](stale-detection.codelore.md#staleblockinfofor) и выдаёт предупреждение только при найденном расхождении. Значение по умолчанию причины `block.staleReason ?? "code_changed"` в сообщении совпадает с конвенцией из `staleReasonFor` (src/service/stale-detection.ts), где `"code_changed"` выдаётся при изменении нескольких фасетов.

## Чего не делает

- Если [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) вернул `undefined`, функция сразу возвращает `undefined`: блок без доступного отпечатка никогда не получает issue, даже если на самом деле устарел. Это ветвь `if (currentValue === undefined) { return undefined; }`.
- Для не-tombstoned блока наличие расхождения целиком определяет [`staleBlockInfoFor`](stale-detection.codelore.md#staleblockinfofor): если он вернул `undefined`, функция молча завершается и собственную проверку «текущий отпечаток против сохранённого» не проводит.
- В ветке tombstoned вычисленный `currentValue` не используется: предупреждение строится только из метаданных `block.staleSince`, `block.staleFacets` и `block.staleReason`, без сравнения с текущим состоянием кода.

## Как менять и что проверять

- Блок без доступного отпечатка молча пропускается: инвариант закреплён ранним выходом `if (currentValue === undefined) { return undefined; }`.
- Tombstoned-блок всегда помечается `drift: "tombstoned"`, а не живым сравнением: инвариант закреплён условием `if (block.staleSince !== undefined)`.
- Для tombstoned-блока без `staleFacets` в предупреждение попадает весь набор фасетов блока: инвариант закреплён выражением `block.staleFacets ?? [...BLOCK_FACETS[blockId]]`.
- Функция возвращает только предупреждения с фиксированным кодом: инвариант закреплён литералами `code: "stale_block"` и `severity: "warning"`.

# validateDependencies

## Зачем это нужно

Сигнализирует о секциях, которые ссылаются на несуществующие сущности или другие секции в поле `depends`.

## Что делает

- Итерирует по `section.depends` и проверяет наличие идентификатора в `codeEntities` или `docSections` (с учётом префикса `section:`).
- Для каждого отсутствующего идентификатора возвращает `DocValidationIssue` с кодом `broken_dependency` и уровнем `error`.
- Не проверяет транзитивные зависимости.

## На что можно положиться

Возвращает пустой массив, если все зависимости разрешены. Не изменяет переданные объекты.

## От чего зависит

Не импортирует утилит из других модулей; использует только типы `DocSection`, `CodeEntity`, `DocValidationIssue` из `../types`.

## Кто и как использует

Вызывается из [`CodeloreService.validateDocs`](codelore-service.codelore.md#validatedocs) для каждой секции. Функция итерирует по `section.depends`, нормализуя идентификаторы (убирая префикс `section:`), и проверяет их наличие в `codeEntities` или `docSections`. При отсутствии формирует `DocValidationIssue` с кодом `broken_dependency` и уровнем `error`.

## Как менять и что проверять

1. Всегда возвращает пустой массив, если все зависимости разрешены — конструкция: `if (!codeEntities[dependencyId] && !docSections[dependencyId] && !docSections[normalizedSectionId])` добавляет issue только при отсутствии во всех трёх источниках.
2. Не изменяет переданные объекты — функция только читает `section.depends` и словари, не присваивает их полям.

# validateBlockQuality

## Зачем это нужно

Проверяет, что каждый блок документации содержит непустое тело, не являющееся заглушкой.

## Что делает

- Итерирует по всем блокам секции.
- Для каждого блока проверяет наличие свойства `rendered` и непустоту тела после обрезки.
- Если блок не отрисован или его тело пустое либо равно "TODO", возвращает issue с кодом `empty_required_block` и уровнем `warning`.

## На что можно положиться

Не изменяет переданные объекты. Возвращает issue для каждого проблемного блока; пустой массив, если все блоки корректны.

## От чего зависит

Не импортирует утилит из других модулей; использует только типы `DocSection`, `DocValidationIssue` из `../types`.

## Кто и как использует

Вызывается из [`CodeloreService.validateDocs`](codelore-service.codelore.md#validatedocs) только при `includeQuality: true`. Для каждого блока секции проверяет наличие свойства `rendered` и непустоту тела после обрезки (исключая заглушку "TODO"). При проблеме формирует `DocValidationIssue` с кодом `empty_required_block` и уровнем `warning`.

## Как менять и что проверять

1. Возвращает issue для каждого блока без `rendered` — конструкция: `if (!block.rendered)`.
2. Возвращает issue для каждого блока с пустым или "TODO" телом — конструкция: `if (body.length === 0 || body === "TODO")`.
