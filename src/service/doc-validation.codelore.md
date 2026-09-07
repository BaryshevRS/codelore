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

## Зачем это нужно

Определяет, является ли один блок документации устаревшим, сравнивая текущий отпечаток с сохранённым.

## Что делает

- Вычисляет текущий отпечаток блока через [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint).
- Если блок помечен как удалённый (`staleSince`), возвращает issue с `drift: "tombstoned"`.
- Иначе сравнивает `storedValue` и `currentValue`; при расхождении определяет изменившиеся фасеты через [`diffFacetHashes`](../markdown/block-facets.codelore.md#difffacethashes).
- Возвращает `undefined`, если отпечаток вычислить не удалось или значения совпадают.

## На что можно положиться

Не изменяет переданные объекты. Возвращает issue с кодом `stale_block` и уровнем `warning` при расхождении; `undefined` при совпадении.

## От чего зависит

- [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint) (`src/markdown/block-facets.ts`) — вычисляет текущий отпечаток блока.
- [`diffFacetHashes`](../markdown/block-facets.codelore.md#difffacethashes) (`src/markdown/block-facets.ts`) — определяет изменившиеся фасеты.
- [`parseBlockFingerprintValue`](../markdown/block-facets.codelore.md#parseblockfingerprintvalue) (`src/markdown/block-facets.ts`) — парсит сохранённую строку отпечатка.

## Кто и как использует

Вызывается из [`detectStaleBlocks`](#detectstaleblocks) для каждого блока секции. Функция сначала пытается вычислить текущий отпечаток через [`computeBlockFingerprint`](../markdown/block-facets.codelore.md#computeblockfingerprint). Если он не вычислен, возвращает `undefined`. Иначе, если блок помечен как удалённый (`staleSince`), возвращает issue с типом `tombstoned`. В противном случае сравнивает сохранённый и текущий отпечатки; при расхождении вызывает [`diffFacetHashes`](../markdown/block-facets.codelore.md#difffacethashes) для определения изменившихся фасетов и формирует issue.

## Чего не делает

- Не проверяет блоки, у которых отсутствует сохранённый отпечаток (`storedValue === undefined`): возвращает `undefined`, а не issue.
- Не вычисляет отпечаток, если `presentOwns` не содержит owned-сущностей (`currentValue === undefined`): возвращает `undefined`.

## Как менять и что проверять

1. При `currentValue === undefined` возвращает `undefined` — конструкция: `if (currentValue === undefined) { return undefined; }`.
2. При совпадении отпечатков возвращает `undefined` — конструкция: `if (storedValue === undefined || storedValue === currentValue) { return undefined; }`.

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
