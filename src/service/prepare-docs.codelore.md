# emptyDocState

```ts
emptyDocState(docPath: string): DocState
```

## Зачем это нужно

Создаёт пустое состояние документа — стартовую точку, с которой [`prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) начинает наполнять новый файл, когда в хранилище нет сохранённого состояния (`existing ?? emptyDocState(docPath)`).

## Что делает

- Заполняет `version` константой `DOC_STATE_VERSION`, `docPath` — переданным аргументом без нормализации, а `generatedAt` — ISO-строкой текущего момента.
- Инициализирует `sectionOrder` пустым массивом и `sections` пустым объектом, поэтому результат готов к наполнению секциями.
- Не обращается к диску и не проверяет существование пути.

## На что можно положиться

- Каждый вызов возвращает новый независимый объект: изменения в `sectionOrder` или `sections` результата не затрагивают результаты других вызовов.
- Функция не бросает исключений при любом строковом аргументе.

## От чего зависит

Единственные внешние зависимости — константа `DOC_STATE_VERSION` из `../storage/doc-state-storage.js`, которая попадает в поле `version` результата, и тип `DocState` из `../types.js`, задающий форму возвращаемого объекта. Больше модулей функция не импортирует: `docPath` приходит аргументом, а `generatedAt` функция вычисляет сама через `new Date()`.

## Кто и как использует

Единственный вызывающий — [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) (src/service/codelore-service.ts). Внутри цикла по группам пропущенных сущностей он пробует `loadDocState(docPath)`, и когда хранилище не вернуло состояние, создаёт его через `existing ?? emptyDocState(docPath)`. Возвращённый объект метод мутирует на месте: добавляет id сущностей в `sectionOrder` (файловые — в начало, остальные — в конец), обновляет `generatedAt` и сохраняет результат через `docStateStorage.saveDocState(state)`.

# allowedBlockIds

## Зачем это нужно

Определяет, какие идентификаторы блоков разрешены для указанной сущности.

## Что делает

- Если `entity.metadata?.allowedBlocks` существует и непуст, возвращает его копию.
- Иначе возвращает копию `BLOCK_IDS` — полный список всех блоков.
- Не проверяет, что возвращаемые идентификаторы относятся к реальным блокам; доверяет источнику.
- Не изменяет переданную сущность.

## На что можно положиться

Возвращаемый массив всегда непуст, так как `BLOCK_IDS` непуст и резервное значение — его копия. Функция никогда не возвращает `undefined` или `null`.

## От чего зависит

Использует `BLOCK_IDS` из модуля `../markdown/block-ids.js` как резервный список разрешённых блоков.

## Кто и как использует

Вызывается [`docStateSectionForPlannedEntity`](#docstatesectionforplannedentity) (тот же файл) для определения набора блоков, которые могут быть сгенерированы для сущности.

# orderBlocks

```ts
orderBlocks(allowed: BlockId[]): BlockId[]
```

## Зачем это нужно

Упорядочивает разрешённые идентификаторы блоков согласно каноническому порядку из `BLOCK_IDS`.

## Что делает

- Принимает массив `allowed` идентификаторов блоков.
- Строит `Set` из `allowed` для быстрой проверки.
- Возвращает отфильтрованную копию `BLOCK_IDS`, содержащую только элементы из множества.
- Сохраняет относительный порядок `BLOCK_IDS`, а не порядок входного массива.

## На что можно положиться

Длина выходного массива ≤ длина `allowed`. Если `allowed` пуст, возвращает пустой массив. Никогда не мутирует входные данные.

## От чего зависит

Использует `BLOCK_IDS` из модуля `../markdown/block-ids.js` для получения канонического порядка блоков.

## Кто и как использует

Вызывается [`docStateSectionForPlannedEntity`](#docstatesectionforplannedentity) (тот же файл) для упорядочивания разрешённых блоков в порядке, заданном `BLOCK_IDS`. Результат используется для итерации при создании объектов блоков.

# anchorForHeading

```ts
anchorForHeading(heading: string): string
```

## Зачем это нужно

Преобразует строку заголовка в якорь, удаляя недопустимые символы и заменяя пробелы на дефисы, для использования в HTML-ссылках и навигации по документу.

## Что делает

- Обрезает начальные и конечные пробелы с помощью .trim().
- Приводит строку к нижнему регистру через .toLowerCase().
- Удаляет все символы, кроме латиницы, кириллицы, цифр, пробелов и дефисов, с помощью replace(/[^a-z0-9а-яё\s-]/gi, "").
- Заменяет последовательности пробелов на один дефис через replace(/\s+/g, "-").

## На что можно положиться

- Возвращает строку, не содержащую пробелов (все заменены на дефис).
- Для пустой строки или строки только из пробелов возвращает пустую строку.
- Всегда возвращает строку, никогда не бросает исключений.

## От чего зависит

Нет внешних зависимостей; использует только встроенные методы String (trim, toLowerCase, replace) и регулярные выражения.

## Кто и как использует

Вызывается функцией docStateSectionForPlannedEntity для генерации якоря из заголовка планируемой секции. Результат присваивается полю anchor возвращаемого объекта DocStateSection.

## Чего не делает

Не сохраняет символы, не входящие в латиницу, кириллицу, цифры, пробелы или дефисы — все прочие символы (например, подчёркивания, знаки препинания, символы других алфавитов) удаляются регулярным выражением /[^a-z0-9а-яё\s-]/gi.

# preparedDocsResult

## Зачем это нужно

Собирает полный результат `PrepareInitialDocsResult` из вычисленных секций и метаданных.

## Что делает

- Преобразует `scope` в публичное представление через [`publicPrepareScope`](#publicpreparescope).
- Определяет следующий шаг через [`prepareInitialDocsNextStep`](#prepareinitialdocsnextstep) и вставляет его в результат.
- Строит сводку через [`prepareInitialDocsSummary`](#prepareinitialdocssummary).
- Собирает пропущенные блоки через [`collectSkippedBlocksByEntity`](#collectskippedblocksbyentity).
- Не вычисляет `plannedSections`, `createdSections` или `skippedSections`; они переданы готовыми.

## На что можно положиться

Возвращаемый объект содержит все указанные поля: `dryRun`, `scope`, `nextAction`, `guidance`, `summary`, `plannedSections`, `createdSections`, `skippedSections`, `skippedBlocksByEntity`. Значения полей — ссылки на переданные объекты, без глубокого копирования.

## Кто и как использует

Вызывается [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) (src/service/codelore-service.ts) после обработки всех сущностей для сборки финального результата. Делегирует вычисление следующего шага в [`prepareInitialDocsNextStep`](#prepareinitialdocsnextstep) и сводку в [`prepareInitialDocsSummary`](#prepareinitialdocssummary).

# withPreservedBlockBodies

```ts
withPreservedBlockBodies(previous: DocStateSection, fresh: DocStateSection): DocStateSection
```

## Зачем это нужно

Сохраняет тела блоков из предыдущего состояния секции при обновлении, если новая секция не содержит собственного текста.

## Что делает

- Для каждого блока `previous`: если его тело непустое, а соответствующего блока в `fresh` нет или его тело пустое, то копирует предыдущий блок в `fresh`.
- Добавляет идентификатор блока в `fresh.blockOrder` и `fresh.allowedBlocks`, если он там отсутствует.
- Не изменяет предыдущее состояние.
- Возвращает мутированный объект `fresh`.

## На что можно положиться

- Мутирует переданный объект `fresh` in-place и возвращает его.
- Блоки из `previous` с пустым телом не копируются; исключение: если в `fresh` есть блок с тем же идентификатором и пустым телом, а у предыдущего блока задан `fingerprint`, то `fingerprint` копируется в свежий блок.
- Блоки из `previous` с непустым телом копируются в `fresh` только при условии, что в `fresh` нет блока с тем же идентификатором или его тело пустое.
- Функция никогда не удаляет блоки из `fresh` и не перезаписывает блоки с непустым телом.

## Кто и как использует

Два метода вызывают `withPreservedBlockBodies` при обновлении существующей секции: [`prepareDomainDocs`](codelore-service.codelore.md#codeloreservicepreparedomaindocs) и [`prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs).

## Как менять и что проверять

- Пустой блок из previous не копируется — проверка `prevBlock.body.trim() === ""` пропускает его тело, копируя только `fingerprint` при совпадении у fresh.
- Блок с непустым телом из previous не перезаписывает непустой блок в fresh — проверка `freshBlock && freshBlock.body.trim() !== ""` прерывает копирование.

# docStateSectionForPlannedEntity

```ts
docStateSectionForPlannedEntity(planned: PlannedFileSection, entity: CodeEntity): DocStateSection
```

## Зачем это нужно

Преобразует запланированную секцию файла и соответствующую сущность кода в структуру `DocStateSection`, готовую для сохранения в хранилище состояний документации, при этом сохраняя тела блоков из предыдущего состояния, если они не пусты.

## Что делает

- Устанавливает `body` и `rendered` для каждого блока.
- Использует [`orderBlocks(allowed)`](#orderblocks) для определения порядка блоков.
- Собирает `depends` и `usedBy` из `entity.directDeps` и `entity.directUsages`, и дедуплицирует их через [`uniqueSorted`](helpers.codelore.md#uniquesorted).
- Включает `signature` только для не-файловых сущностей с непустой сигнатурой, и всегда устанавливает `owns` в `[entity.id]`.

## На что можно положиться

- `blockOrder` always matches the global order of `BLOCK_IDS` because it is produced by [`orderBlocks(allowed)`](#orderblocks).
- `depends` and `usedBy` arrays are deduplicated and sorted via [`uniqueSorted([...entity.directDeps])`](helpers.codelore.md#uniquesorted) and [`uniqueSorted([...entity.directUsers])`](helpers.codelore.md#uniquesorted), so callers can rely on stable ordering and no duplicates.
- The `signature` field is included only when `entity.type !== "file"` and `entity.signature` is truthy; otherwise it is omitted.
- The `owns` array always contains exactly `[entity.id]`.

## От чего зависит

- [`uniqueSorted`](helpers.codelore.md#uniquesorted) (`src/service/helpers.ts`) — дедуплицирует и сортирует массивы `depends` и `usedBy`.

## Кто и как использует

1. [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) calls this function for each planned entity to create a fresh `DocStateSection`.
2. The caller then checks if a previous section exists in `state.sections`; if so, it uses [`withPreservedBlockBodies(previous, fresh)`](#withpreservedblockbodies) to keep existing block bodies, otherwise it uses the fresh section directly.
3. The resulting section is stored in `state.sections` and its id is added to `sectionOrder` (unshifted for file entities, pushed for others).

## Чего не делает

- The `signature` field is omitted for file entities or when `entity.signature` is falsy, enforced by the condition `entity.type !== "file" && entity.signature`.
- The `owns` array is always exactly `[entity.id]`, so it does not reflect any additional ownership beyond the entity itself.

## Как менять и что проверять

- The `blockOrder` is guaranteed to match the global order of `BLOCK_IDS` because it is produced by [`orderBlocks(allowed)`](#orderblocks).
- The `depends` and `usedBy` arrays are deduplicated and sorted via [`uniqueSorted([...entity.directDeps])`](helpers.codelore.md#uniquesorted) and [`uniqueSorted([...entity.directUsers])`](helpers.codelore.md#uniquesorted), ensuring stable ordering and no duplicates.
- The `signature` field is included only when `entity.type !== "file"` and `entity.signature` is truthy; otherwise it is omitted.
- The `owns` array always contains exactly `[entity.id]`.

# normalizePrepareScope

## Зачем это нужно

Приводит входящий скоуп документации к нормализованному формату: очищает пути, устраняет дубликаты, устанавливает `dryRun` по умолчанию `false`.

## Что делает

- Нормализует массивы `paths`, `files` через [`normalizePreparePath`](#normalizepreparepath) и фильтрует пустые строки.
- Дедуплицирует и сортирует все массивы через [`uniqueSorted`](helpers.codelore.md#uniquesorted).
- Гарантирует, что `dryRun` — булево значение (`false`, если не указано).

## На что можно положиться

- Возвращаемый объект всегда имеет поля `paths`, `files`, `entityIds` (массивы) и `dryRun` (булево).
- Все массивы отсортированы по возрастанию и не содержат дубликатов.
- Значения полей копируются, не ссылаются на входные массивы (из-за `map` и `filter` создаются новые массивы).

## От чего зависит

Зависимости:
- [`uniqueSorted`](helpers.codelore.md#uniquesorted) (`src/service/helpers.ts`) — дедуплицирует и сортирует массивы скоупа.
- [`normalizePreparePath`](#normalizepreparepath) (`src/service/prepare-docs.ts`) — нормализует каждый путь перед дедупликацией.

## Кто и как использует

Вызывается первой в [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs). Нормализованный скоуп используется для построения индекса через `buildScopedIndex` и для фильтрации сущностей в скоупе.

# normalizePreparePath

## Зачем это нужно

Приводит путь к POSIX-формату без ведущего `./` и завершающего слеша.

## Что делает

- Преобразует путь через [`toPosixPath`](../utils/path.codelore.md#toposixpath) и удаляет префикс `./` и завершающие слеши.

## На что можно положиться

- Если входная строка пуста, возвращается пустая строка.
- Результат никогда не начинается с `./` и не заканчивается на `/`.

## От чего зависит

Зависимости:
- [`toPosixPath`](../utils/path.codelore.md#toposixpath) (`src/utils/path.ts`) — конвертирует обратные слеши в прямые.

## Кто и как использует

Вызывается из [`normalizePrepareScope`](#normalizepreparescope) при нормализации каждого пути. Применяется в `map`, а результата фильтруются пустые строки.

# publicPrepareScope

## Зачем это нужно

Извлекает из нормализованного скоупа только поля, предназначенные для ответа API (`paths`, `files`, `entityIds`), исключая внутреннее поле `dryRun`.

## На что можно положиться

- Возвращаемый объект содержит те же элементы в тех же массивах, что и входной scope.
- Поле `dryRun` не включается.

## Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для формирования публичного поля `scope` в результате. Просто копирует три массива из нормализованного скоупа, исключая `dryRun`.

# prepareInitialDocsSummary

## Зачем это нужно

Формирует сводку результатов подготовки документации: общее количество сущностей, скоуп, сколько уже задокументировано, запланировано, создано.

## Что делает

- Вычисляет `scopeMode` на основе [`hasPrepareScope`](#haspreparescope): если есть фильтрация — `"scoped"`, иначе `"all"`.
- Устанавливает `totalCodeEntities` и `indexedCodeEntities` равными количеству сущностей в индексе.
- Отражает количество сущностей в скоупе, пропущенных (уже задокументированных), запланированных и созданных секций.

## На что можно положиться

- Все числовые поля неотрицательны.
- `scopeMode` всегда `"scoped"` или `"all"`.
- Значения соответствуют переданным аргументам без трансформации (кроме `indexedCodeEntities` из индекса).

## От чего зависит

Зависимости:
- [`hasPrepareScope`](#haspreparescope) (`src/service/prepare-docs.ts`) — определяет, есть ли фильтрация скоупа.

## Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для заполнения поля `summary` результата. Использует переданные параметры и индекс для подсчёта количества сущностей, скоупа, пропущенных и запланированных секций.

# prepareInitialDocsNextStep

## Зачем это нужно

Определяет следующее действие на основе состояния подготовки: останов, запрос на выполнение без `--dry-run`, запрос на заполнение созданных секций или отчёт о полной документированности.

## Что делает

- Возвращает `nextAction` одно из четырёх значений и соответствующую `guidance`.
- Проверяет в порядке приоритета: пустой скоуп, dry run с незаполненными секциями, созданные секции, полностью задокументировано.
- Не изменяет состояние, чистая функция.

## На что можно положиться

- Если `scopedEntities.length === 0`, возвращается `"stop_no_matching_entities"`.
- Если `scope.dryRun` истина и `plannedSections.length > 0`, возвращается `"run_without_dry_run"`.
- Иначе, если `createdSections.length > 0`, возвращается `"fill_created_sections"`.
- Иначе, если `skippedSections.length > 0`, возвращается `"stop_already_documented"`.
- Иначе возвращается `"stop_no_matching_entities"`.

## Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для определения `nextAction` и `guidance`. Проверяет условия в фиксированном порядке приоритета и возвращает соответствующее действие и инструкцию.

## Как менять и что проверять

1. `scopedEntities.length === 0` — первая проверка, немедленный возврат `stop_no_matching_entities` без дальнейших условий.
2. `scope.dryRun && plannedSections.length > 0` — вторая проверка, возврат `run_without_dry_run`.

# codeIndexScopeFromPrepareScope

## Зачем это нужно

Преобразует `NormalizedPrepareScope` в `CodeIndexScope` для построения частичного индекса, если область задана.

## Что делает

- Проверяет наличие области через [`hasPrepareScope`](#haspreparescope) и возвращает `undefined` при её отсутствии.
- При наличии области копирует массивы `paths`, `files` и `entityIds` без изменений.
- Не валидирует содержимое массивов и не фильтрует сущности.

## На что можно положиться

Возвращает `undefined` только когда [`hasPrepareScope`](#haspreparescope) возвращает `false`. В противном случае возвращает `CodeIndexScope` с теми же значениями полей, что и входной `scope`, включая пустые массивы.

## От чего зависит

[`hasPrepareScope`](#haspreparescope) (`src/service/prepare-docs.ts`) — проверяет наличие хотя бы одного фильтра в области.

## Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для построения частичного индекса. Если [`hasPrepareScope`](#haspreparescope) возвращает `false`, возвращается `undefined`, и `buildScopedIndex` индексирует весь проект. Иначе возвращается объект с полями `paths`, `files`, `entityIds` из области.

## Чего не делает

Не фильтрует пустые массивы — если все три массива пусты, [`hasPrepareScope`](#haspreparescope) возвращает `false`, и функция возвращает `undefined`, а не объект с пустыми массивами.

# hasPrepareScope

## Зачем это нужно

Определяет, задан ли хотя бы один фильтр области в `NormalizedPrepareScope`.

## Что делает

- Проверяет три поля: `paths`, `files`, `entityIds`.
- Возвращает `true`, если хотя бы один массив не пуст.
- Не анализирует содержимое элементов.

## На что можно положиться

Всегда возвращает `false`, когда все три массива пусты. Возвращает `true` при любом непустом массиве, независимо от допустимости значений.

## Кто и как использует

Вызывается из [`codeIndexScopeFromPrepareScope`](#codeindexscopefrompreparescope) для решения о возврате `undefined`. Вызывается из [`prepareInitialDocsSummary`](#prepareinitialdocssummary) для определения `scopeMode`. Вызывается из [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для выбора между полным и частичным индексом.

## Чего не делает

Не проверяет содержимое элементов массивов — пустой массив с невалидными значениями всё равно даёт `false`.

# skippedPreparedDocSection

## Зачем это нужно

Формирует запись о пропущенной секции для сущности, которая уже задокументирована.

## Что делает

- Извлекает идентификаторы секций из `index.docs.entityToSections[entity.id]`.
- Преобразует их в пути документов через `index.docs.sections`.
- Дедуплицирует пути с помощью [`uniqueSorted`](helpers.codelore.md#uniquesorted).
- Выставляет причину `'already_documented'`.

## На что можно положиться

Всегда возвращает `reason === 'already_documented'`. Если у сущности нет секций, возвращает пустой `sectionIds` и пустой `docPaths`.

## От чего зависит

[`uniqueSorted`](helpers.codelore.md#uniquesorted) (`src/service/helpers.ts`) — дедуплицирует и сортирует пути документов.

## Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для каждой сущности, которая уже задокументирована. Результат включается в `skippedSections` и возвращается в `PrepareInitialDocsResult`.

## Чего не делает

Не проверяет, что `sectionId` существует в `index.docs.sections` — если секция удалена из индекса, `docPaths` может содержать `undefined`, который отфильтровывается через `.filter(Boolean)`.

# isSectionSkeleton

## Зачем это нужно

Определяет, пуста ли секция документации (содержит только скелет без содержимого).

## Что делает

- Проверяет все блоки секции.
- Возвращает `true`, если каждый блок имеет пустое тело после обрезки пробелов.
- Не модифицирует секцию.

## На что можно положиться

Не вызывает побочных эффектов. Возвращает `false`, если хотя бы один блок содержит непробельные символы.

## Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для фильтрации секций, которые уже имеют содержимое. Используется в `documentedEntities` для определения, какие сущности уже задокументированы.

## Чего не делает

Не различает блоки с пробельными символами и полностью пустые — `trim()` считает пробелы пустотой.

# isEntityInPrepareScope

## Зачем это нужно

Проверяет, входит ли сущность в заданный фильтр области документирования.

## Что делает

- Принимает `entity` и `scope`.
- Возвращает `true`, если область пуста.
- Иначе проверяет совпадение `entity.id` с `scope.entityIds`, `entity.path` с `scope.files`, или `entity.path` начинается с одного из `scope.paths` с добавлением `/`.
- Не проверяет дубликаты.

## На что можно положиться

Возвращает `true` при отсутствии области (все массивы пусты). Возвращает `true`, если сущность совпадает хотя бы по одному критерию, даже если другие не совпадают.

## Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для фильтрации `scopedEntities`. Каждая сущность проверяется на вхождение в область; результат используется для формирования списка сущностей для документирования.

## Как менять и что проверять

1. Инвариант «возвращает `true` при отсутствии области» закреплён в условии `if (!hasScope) { return true; }`.
2. Инвариант «проверяет совпадение по пути через `startsWith` с добавлением `/`» закреплён в выражении `entity.path.startsWith(`${path}/`)`.

# shouldCreatePage

## Зачем это нужно

Определяет, следует ли создавать новую страницу документации для сущности.

## Что делает

- Проверяет `entity.metadata?.role`.
- Возвращает `true`, если `metadata` отсутствует или роль равна `'short_page'` или `'full_page'`.
- Иначе возвращает `false`.

## На что можно положиться

Возвращает `false` только когда `entity.metadata?.role` явно установлено в значение, отличное от `'short_page'` и `'full_page'`. Отсутствие метаданных трактуется как разрешение на создание.

## Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](codelore-service.codelore.md#prepareinitialdocs) для фильтрации `missingEntities`. Сущности, для которых функция возвращает `false`, исключаются из списка на создание документации.

## Чего не делает

Не обрабатывает случай, когда `entity.metadata` существует, но `role` отсутствует — тогда `entity.metadata?.role` возвращает `undefined`, и функция возвращает `false`.

# collectSkippedBlocksByEntity

## Зачем это нужно

Собирает информацию о пропущенных блоках для каждой сущности из переданных секций, чтобы включить её в результат подготовки документации.

## Что делает

- Фильтрует дублирующиеся записи об одной сущности, используя `Set<string>`.
- Извлекает `skippedBlocks` из метаданных сущности, если они есть.
- Сортирует результат по `entityId` в алфавитном порядке.
- Возвращает пустой массив, если ни у одной сущности нет пропущенных блоков.

## На что можно положиться

Результат отсортирован по `entityId` в порядке возрастания (`localeCompare`). Каждая сущность встречается не более одного раза.

## От чего зависит

`../types.js` — типы `PreparedDocSection`, `CodeEntity`, `BlockSkipReason`.

## Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для заполнения поля `skippedBlocksByEntity` в результате `PrepareInitialDocsResult`. [`preparedDocsResult`](#prepareddocsresult) передаёт объединённый массив `[...plannedSections, ...createdSections]` и `index.code.entities`. Функция обходит секции, собирает сущности с пропущенными блоками из метаданных и возвращает отсортированный по `entityId` список.

## Как менять и что проверять

- Дедупликация по `entityId`: каждая сущность присутствует в результате не более одного раза. Конструкт: `new Set<string>()` и `seen.has(entityId)`. Тест не указан.
- Порядок результатов: список отсортирован лексикографически по `entityId`. Конструкт: `.sort((left, right) => left.entityId.localeCompare(right.entityId))`. Тест не указан.
