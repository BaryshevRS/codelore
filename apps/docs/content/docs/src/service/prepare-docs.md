---
title: emptyDocState
---

## Зачем это нужно

Создаёт пустой `DocState` для нового документа, заданного путём.

## Что делает

* Устанавливает `version` из константы `DOC_STATE_VERSION`.
* Устанавливает `docPath` переданным значением, `generatedAt` — текущей ISO-строкой.
* Инициализирует `sectionOrder` пустым массивом и `sections` пустым объектом.
* Не создаёт никаких секций или блоков — `DocState` готов к наполнению.

## На что можно положиться

Всегда возвращает объект с `version: DOC_STATE_VERSION`, `docPath` как передано, `generatedAt` — текущей датой, `sectionOrder` пуст, `sections` пуст. Никогда не бросает исключения.

## От чего зависит

Использует константу `DOC_STATE_VERSION` из модуля `../storage/doc-state-storage.js` для установки версии состояния.

## Кто и как использует

Вызывается [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) (src/service/codelore-service.ts), когда для файла источника не найдено сохранённое состояние (`existing ?? emptyDocState(docPath)`). Результат затем наполняется секциями и сохраняется в хранилище.

## allowedBlockIds

### Зачем это нужно

Определяет, какие идентификаторы блоков разрешены для указанной сущности.

### Что делает

* Если `entity.metadata?.allowedBlocks` существует и непуст, возвращает его копию.
* Иначе возвращает копию `BLOCK_IDS` — полный список всех блоков.
* Не проверяет, что возвращаемые идентификаторы относятся к реальным блокам; доверяет источнику.
* Не изменяет переданную сущность.

### На что можно положиться

Возвращаемый массив всегда непуст, так как `BLOCK_IDS` непуст и резервное значение — его копия. Функция никогда не возвращает `undefined` или `null`.

### От чего зависит

Использует `BLOCK_IDS` из модуля `../markdown/block-ids.js` как резервный список разрешённых блоков.

### Кто и как использует

Вызывается [`docStateSectionForPlannedEntity`](#docstatesectionforplannedentity) (тот же файл) для определения набора блоков, которые могут быть сгенерированы для сущности.

## orderBlocks

### Зачем это нужно

Упорядочивает разрешённые идентификаторы блоков согласно каноническому порядку из `BLOCK_IDS`.

### Что делает

* Принимает массив `allowed` идентификаторов блоков.
* Строит `Set` из `allowed` для быстрой проверки.
* Возвращает отфильтрованную копию `BLOCK_IDS`, содержащую только элементы из множества.
* Сохраняет относительный порядок `BLOCK_IDS`, а не порядок входного массива.

### На что можно положиться

Длина выходного массива ≤ длина `allowed`. Если `allowed` пуст, возвращает пустой массив. Никогда не мутирует входные данные.

### От чего зависит

Использует `BLOCK_IDS` из модуля `../markdown/block-ids.js` для получения канонического порядка блоков.

### Кто и как использует

Вызывается [`docStateSectionForPlannedEntity`](#docstatesectionforplannedentity) (тот же файл) для упорядочивания разрешённых блоков в порядке, заданном `BLOCK_IDS`. Результат используется для итерации при создании объектов блоков.

## anchorForHeading

### Зачем это нужно

Преобразует строку заголовка в якорь, удаляя недопустимые символы и заменяя пробелы на дефисы, для использования в HTML-ссылках и навигации по документу.

### Что делает

* Обрезает начальные и конечные пробелы с помощью .trim().
* Приводит строку к нижнему регистру через .toLowerCase().
* Удаляет все символы, кроме латиницы, кириллицы, цифр, пробелов и дефисов, с помощью replace(/\[^a-z0-9а-яё\s-]/gi, "").
* Заменяет последовательности пробелов на один дефис через replace(/\s+/g, "-").

### На что можно положиться

* Возвращает строку, не содержащую пробелов (все заменены на дефис).
* Для пустой строки или строки только из пробелов возвращает пустую строку.
* Всегда возвращает строку, никогда не бросает исключений.

### От чего зависит

Нет внешних зависимостей; использует только встроенные методы String (trim, toLowerCase, replace) и регулярные выражения.

### Кто и как использует

Вызывается функцией docStateSectionForPlannedEntity для генерации якоря из заголовка планируемой секции. Результат присваивается полю anchor возвращаемого объекта DocStateSection.

### Чего не делает

Не сохраняет символы, не входящие в латиницу, кириллицу, цифры, пробелы или дефисы — все прочие символы (например, подчёркивания, знаки препинания, символы других алфавитов) удаляются регулярным выражением /\[^a-z0-9а-яё\s-]/gi.

## preparedDocsResult

### Зачем это нужно

Собирает полный результат `PrepareInitialDocsResult` из вычисленных секций и метаданных.

### Что делает

* Преобразует `scope` в публичное представление через [`publicPrepareScope`](#publicpreparescope).
* Определяет следующий шаг через [`prepareInitialDocsNextStep`](#prepareinitialdocsnextstep) и вставляет его в результат.
* Строит сводку через [`prepareInitialDocsSummary`](#prepareinitialdocssummary).
* Собирает пропущенные блоки через [`collectSkippedBlocksByEntity`](#collectskippedblocksbyentity).
* Не вычисляет `plannedSections`, `createdSections` или `skippedSections`; они переданы готовыми.

### На что можно положиться

Возвращаемый объект содержит все указанные поля: `dryRun`, `scope`, `nextAction`, `guidance`, `summary`, `plannedSections`, `createdSections`, `skippedSections`, `skippedBlocksByEntity`. Значения полей — ссылки на переданные объекты, без глубокого копирования.

### Кто и как использует

Вызывается [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) (src/service/codelore-service.ts) после обработки всех сущностей для сборки финального результата. Делегирует вычисление следующего шага в [`prepareInitialDocsNextStep`](#prepareinitialdocsnextstep) и сводку в [`prepareInitialDocsSummary`](#prepareinitialdocssummary).

## withPreservedBlockBodies

### Зачем это нужно

Сохраняет тела блоков из предыдущего состояния секции при обновлении, если новая секция не содержит собственного текста.

### Что делает

* Для каждого блока `previous`: если его тело непустое, а соответствующего блока в `fresh` нет или его тело пустое, то копирует предыдущий блок в `fresh`.
* Добавляет идентификатор блока в `fresh.blockOrder` и `fresh.allowedBlocks`, если он там отсутствует.
* Не изменяет предыдущее состояние.
* Возвращает мутированный объект `fresh`.

### На что можно положиться

Мутирует объект `fresh` in-place. Если в `previous` есть блоки с пустым телом, они игнорируются. Если в `fresh` уже есть блок с непустым телом, он не перезаписывается. Функция никогда не удаляет блоки из `fresh`.

### Кто и как использует

Вызывается [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) (src/service/codelore-service.ts) при обновлении существующей секции документа. После создания свежей секции вызывается `withPreservedBlockBodies(previous, fresh)`, если `previous` существует. Сохраняет текстовое наполнение блоков из `previous`, если в `fresh` нет непустого тела.

### Как менять и что проверять

1. Блоки с пустым телом в `previous` игнорируются. Обеспечивает проверка `if (prevBlock.body.trim() === "") { continue; }`.
2. Если в `fresh` уже есть блок с непустым телом, он не перезаписывается. Обеспечивает проверка `if (freshBlock && freshBlock.body.trim() !== "") { continue; }`.

## docStateSectionForPlannedEntity

### Зачем это нужно

Создаёт пустой скелет секции документации для сущности, объединяя данные разметки файла (`planned.heading`, `planned.depth`) с зависимостями и потребителями сущности.

### Что делает

* Делегирует вычисление разрешённых блоков [`allowedBlockIds(entity)`](#allowedblockids), сортировку — [`orderBlocks`](#orderblocks).
* Устанавливает `owns` как `[entity.id]`, `depends` и `usedBy` как отсортированные без дубликатов массивы из `entity.directDeps` и `entity.directUsages`.
* Создаёт пустое тело для каждого блока (`body: ""`) и добавляет отпечаток `fingerprint` через [`computeBlockFingerprint`](/docs/src/markdown/block-facets#computeblockfingerprint), если он определён.
* Генерирует `anchor` из `planned.heading` функцией [`anchorForHeading`](#anchorforheading).

### На что можно положиться

* Возвращаемая секция всегда имеет `status: "normal"`.
* Порядок блоков в `blockOrder` соответствует порядку, полученному из [`orderBlocks`](#orderblocks), который сам следует глобальному порядку `BLOCK_IDS`.
* Поля `depends` и `usedBy` отсортированы и не содержат дубликатов (гарантируется [`uniqueSorted`](/docs/src/service/helpers#uniquesorted)).

### От чего зависит

Зависимости:

* [`computeBlockFingerprint`](/docs/src/markdown/block-facets#computeblockfingerprint) (`src/markdown/block-facets.ts`) — вычисляет отпечаток для каждого блока.
* [`uniqueSorted`](/docs/src/service/helpers#uniquesorted) (`src/service/helpers.ts`) — дедуплицирует и сортирует массивы `depends` и `usedBy`.

### Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) для каждой запланированной секции в цикле по файлам и группам сущностей. Для каждой секции создаётся свежий `DocStateSection` с пустыми телами блоков. Если в хранилище уже есть предыдущая секция для той же сущности, вызывающий объединяет её с новой, иначе секция сохраняется как есть. Новая секция добавляется в `sectionOrder`, если её там ещё нет. Затем состояние сохраняется через `this.docStateStorage.saveDocState(state)`.

### Как менять и что проверять

1. [`orderBlocks(allowed)`](#orderblocks) гарантирует, что `blockOrder` совпадает с глобальным порядком `BLOCK_IDS`.
2. [`uniqueSorted([...entity.directDeps])`](/docs/src/service/helpers#uniquesorted) и [`uniqueSorted([...entity.directUsages])`](/docs/src/service/helpers#uniquesorted) гарантируют отсутствие дубликатов и сортировку в массивах `depends` и `usedBy`.

## normalizePrepareScope

### Зачем это нужно

Приводит входящий скоуп документации к нормализованному формату: очищает пути, устраняет дубликаты, устанавливает `dryRun` по умолчанию `false`.

### Что делает

* Нормализует массивы `paths`, `files` через [`normalizePreparePath`](#normalizepreparepath) и фильтрует пустые строки.
* Дедуплицирует и сортирует все массивы через [`uniqueSorted`](/docs/src/service/helpers#uniquesorted).
* Гарантирует, что `dryRun` — булево значение (`false`, если не указано).

### На что можно положиться

* Возвращаемый объект всегда имеет поля `paths`, `files`, `entityIds` (массивы) и `dryRun` (булево).
* Все массивы отсортированы по возрастанию и не содержат дубликатов.
* Значения полей копируются, не ссылаются на входные массивы (из-за `map` и `filter` создаются новые массивы).

### От чего зависит

Зависимости:

* [`uniqueSorted`](/docs/src/service/helpers#uniquesorted) (`src/service/helpers.ts`) — дедуплицирует и сортирует массивы скоупа.
* [`normalizePreparePath`](#normalizepreparepath) (`src/service/prepare-docs.ts`) — нормализует каждый путь перед дедупликацией.

### Кто и как использует

Вызывается первой в [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs). Нормализованный скоуп используется для построения индекса через `buildScopedIndex` и для фильтрации сущностей в скоупе.

## normalizePreparePath

### Зачем это нужно

Приводит путь к POSIX-формату без ведущего `./` и завершающего слеша.

### Что делает

* Преобразует путь через [`toPosixPath`](/docs/src/utils/path#toposixpath) и удаляет префикс `./` и завершающие слеши.

### На что можно положиться

* Если входная строка пуста, возвращается пустая строка.
* Результат никогда не начинается с `./` и не заканчивается на `/`.

### От чего зависит

Зависимости:

* [`toPosixPath`](/docs/src/utils/path#toposixpath) (`src/utils/path.ts`) — конвертирует обратные слеши в прямые.

### Кто и как использует

Вызывается из [`normalizePrepareScope`](#normalizepreparescope) при нормализации каждого пути. Применяется в `map`, а результата фильтруются пустые строки.

## publicPrepareScope

### Зачем это нужно

Извлекает из нормализованного скоупа только поля, предназначенные для ответа API (`paths`, `files`, `entityIds`), исключая внутреннее поле `dryRun`.

### На что можно положиться

* Возвращаемый объект содержит те же элементы в тех же массивах, что и входной scope.
* Поле `dryRun` не включается.

### Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для формирования публичного поля `scope` в результате. Просто копирует три массива из нормализованного скоупа, исключая `dryRun`.

## prepareInitialDocsSummary

### Зачем это нужно

Формирует сводку результатов подготовки документации: общее количество сущностей, скоуп, сколько уже задокументировано, запланировано, создано.

### Что делает

* Вычисляет `scopeMode` на основе [`hasPrepareScope`](#haspreparescope): если есть фильтрация — `"scoped"`, иначе `"all"`.
* Устанавливает `totalCodeEntities` и `indexedCodeEntities` равными количеству сущностей в индексе.
* Отражает количество сущностей в скоупе, пропущенных (уже задокументированных), запланированных и созданных секций.

### На что можно положиться

* Все числовые поля неотрицательны.
* `scopeMode` всегда `"scoped"` или `"all"`.
* Значения соответствуют переданным аргументам без трансформации (кроме `indexedCodeEntities` из индекса).

### От чего зависит

Зависимости:

* [`hasPrepareScope`](#haspreparescope) (`src/service/prepare-docs.ts`) — определяет, есть ли фильтрация скоупа.

### Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для заполнения поля `summary` результата. Использует переданные параметры и индекс для подсчёта количества сущностей, скоупа, пропущенных и запланированных секций.

## prepareInitialDocsNextStep

### Зачем это нужно

Определяет следующее действие на основе состояния подготовки: останов, запрос на выполнение без `--dry-run`, запрос на заполнение созданных секций или отчёт о полной документированности.

### Что делает

* Возвращает `nextAction` одно из четырёх значений и соответствующую `guidance`.
* Проверяет в порядке приоритета: пустой скоуп, dry run с незаполненными секциями, созданные секции, полностью задокументировано.
* Не изменяет состояние, чистая функция.

### На что можно положиться

* Если `scopedEntities.length === 0`, возвращается `"stop_no_matching_entities"`.
* Если `scope.dryRun` истина и `plannedSections.length > 0`, возвращается `"run_without_dry_run"`.
* Иначе, если `createdSections.length > 0`, возвращается `"fill_created_sections"`.
* Иначе, если `skippedSections.length > 0`, возвращается `"stop_already_documented"`.
* Иначе возвращается `"stop_no_matching_entities"`.

### Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для определения `nextAction` и `guidance`. Проверяет условия в фиксированном порядке приоритета и возвращает соответствующее действие и инструкцию.

### Как менять и что проверять

1. `scopedEntities.length === 0` — первая проверка, немедленный возврат `stop_no_matching_entities` без дальнейших условий.
2. `scope.dryRun && plannedSections.length > 0` — вторая проверка, возврат `run_without_dry_run`.

## codeIndexScopeFromPrepareScope

### Зачем это нужно

Преобразует `NormalizedPrepareScope` в `CodeIndexScope` для построения частичного индекса, если область задана.

### Что делает

* Проверяет наличие области через [`hasPrepareScope`](#haspreparescope) и возвращает `undefined` при её отсутствии.
* При наличии области копирует массивы `paths`, `files` и `entityIds` без изменений.
* Не валидирует содержимое массивов и не фильтрует сущности.

### На что можно положиться

Возвращает `undefined` только когда [`hasPrepareScope`](#haspreparescope) возвращает `false`. В противном случае возвращает `CodeIndexScope` с теми же значениями полей, что и входной `scope`, включая пустые массивы.

### От чего зависит

[`hasPrepareScope`](#haspreparescope) (`src/service/prepare-docs.ts`) — проверяет наличие хотя бы одного фильтра в области.

### Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) для построения частичного индекса. Если [`hasPrepareScope`](#haspreparescope) возвращает `false`, возвращается `undefined`, и `buildScopedIndex` индексирует весь проект. Иначе возвращается объект с полями `paths`, `files`, `entityIds` из области.

### Чего не делает

Не фильтрует пустые массивы — если все три массива пусты, [`hasPrepareScope`](#haspreparescope) возвращает `false`, и функция возвращает `undefined`, а не объект с пустыми массивами.

## hasPrepareScope

### Зачем это нужно

Определяет, задан ли хотя бы один фильтр области в `NormalizedPrepareScope`.

### Что делает

* Проверяет три поля: `paths`, `files`, `entityIds`.
* Возвращает `true`, если хотя бы один массив не пуст.
* Не анализирует содержимое элементов.

### На что можно положиться

Всегда возвращает `false`, когда все три массива пусты. Возвращает `true` при любом непустом массиве, независимо от допустимости значений.

### Кто и как использует

Вызывается из [`codeIndexScopeFromPrepareScope`](#codeindexscopefrompreparescope) для решения о возврате `undefined`. Вызывается из [`prepareInitialDocsSummary`](#prepareinitialdocssummary) для определения `scopeMode`. Вызывается из [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) для выбора между полным и частичным индексом.

### Чего не делает

Не проверяет содержимое элементов массивов — пустой массив с невалидными значениями всё равно даёт `false`.

## skippedPreparedDocSection

### Зачем это нужно

Формирует запись о пропущенной секции для сущности, которая уже задокументирована.

### Что делает

* Извлекает идентификаторы секций из `index.docs.entityToSections[entity.id]`.
* Преобразует их в пути документов через `index.docs.sections`.
* Дедуплицирует пути с помощью [`uniqueSorted`](/docs/src/service/helpers#uniquesorted).
* Выставляет причину `'already_documented'`.

### На что можно положиться

Всегда возвращает `reason === 'already_documented'`. Если у сущности нет секций, возвращает пустой `sectionIds` и пустой `docPaths`.

### От чего зависит

[`uniqueSorted`](/docs/src/service/helpers#uniquesorted) (`src/service/helpers.ts`) — дедуплицирует и сортирует пути документов.

### Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) для каждой сущности, которая уже задокументирована. Результат включается в `skippedSections` и возвращается в `PrepareInitialDocsResult`.

### Чего не делает

Не проверяет, что `sectionId` существует в `index.docs.sections` — если секция удалена из индекса, `docPaths` может содержать `undefined`, который отфильтровывается через `.filter(Boolean)`.

## isSectionSkeleton

### Зачем это нужно

Определяет, пуста ли секция документации (содержит только скелет без содержимого).

### Что делает

* Проверяет все блоки секции.
* Возвращает `true`, если каждый блок имеет пустое тело после обрезки пробелов.
* Не модифицирует секцию.

### На что можно положиться

Не вызывает побочных эффектов. Возвращает `false`, если хотя бы один блок содержит непробельные символы.

### Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) для фильтрации секций, которые уже имеют содержимое. Используется в `documentedEntities` для определения, какие сущности уже задокументированы.

### Чего не делает

Не различает блоки с пробельными символами и полностью пустые — `trim()` считает пробелы пустотой.

## isEntityInPrepareScope

### Зачем это нужно

Проверяет, входит ли сущность в заданный фильтр области документирования.

### Что делает

* Принимает `entity` и `scope`.
* Возвращает `true`, если область пуста.
* Иначе проверяет совпадение `entity.id` с `scope.entityIds`, `entity.path` с `scope.files`, или `entity.path` начинается с одного из `scope.paths` с добавлением `/`.
* Не проверяет дубликаты.

### На что можно положиться

Возвращает `true` при отсутствии области (все массивы пусты). Возвращает `true`, если сущность совпадает хотя бы по одному критерию, даже если другие не совпадают.

### Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) для фильтрации `scopedEntities`. Каждая сущность проверяется на вхождение в область; результат используется для формирования списка сущностей для документирования.

### Как менять и что проверять

1. Инвариант «возвращает `true` при отсутствии области» закреплён в условии `if (!hasScope) { return true; }`.
2. Инвариант «проверяет совпадение по пути через `startsWith` с добавлением `/`» закреплён в выражении `entity.path.startsWith(`${path}/`)`.

## shouldCreatePage

### Зачем это нужно

Определяет, следует ли создавать новую страницу документации для сущности.

### Что делает

* Проверяет `entity.metadata?.role`.
* Возвращает `true`, если `metadata` отсутствует или роль равна `'short_page'` или `'full_page'`.
* Иначе возвращает `false`.

### На что можно положиться

Возвращает `false` только когда `entity.metadata?.role` явно установлено в значение, отличное от `'short_page'` и `'full_page'`. Отсутствие метаданных трактуется как разрешение на создание.

### Кто и как использует

Вызывается из [`CodeloreService.prepareInitialDocs`](/docs/src/service/codelore-service#prepareinitialdocs) для фильтрации `missingEntities`. Сущности, для которых функция возвращает `false`, исключаются из списка на создание документации.

### Чего не делает

Не обрабатывает случай, когда `entity.metadata` существует, но `role` отсутствует — тогда `entity.metadata?.role` возвращает `undefined`, и функция возвращает `false`.

## collectSkippedBlocksByEntity

### Зачем это нужно

Собирает информацию о пропущенных блоках для каждой сущности из переданных секций, чтобы включить её в результат подготовки документации.

### Что делает

* Фильтрует дублирующиеся записи об одной сущности, используя `Set<string>`.
* Извлекает `skippedBlocks` из метаданных сущности, если они есть.
* Сортирует результат по `entityId` в алфавитном порядке.
* Возвращает пустой массив, если ни у одной сущности нет пропущенных блоков.

### На что можно положиться

Результат отсортирован по `entityId` в порядке возрастания (`localeCompare`). Каждая сущность встречается не более одного раза.

### От чего зависит

`../types.js` — типы `PreparedDocSection`, `CodeEntity`, `BlockSkipReason`.

### Кто и как использует

Вызывается из [`preparedDocsResult`](#prepareddocsresult) для заполнения поля `skippedBlocksByEntity` в результате `PrepareInitialDocsResult`. [`preparedDocsResult`](#prepareddocsresult) передаёт объединённый массив `[...plannedSections, ...createdSections]` и `index.code.entities`. Функция обходит секции, собирает сущности с пропущенными блоками из метаданных и возвращает отсортированный по `entityId` список.

### Как менять и что проверять

* Дедупликация по `entityId`: каждая сущность присутствует в результате не более одного раза. Конструкт: `new Set<string>()` и `seen.has(entityId)`. Тест не указан.
* Порядок результатов: список отсортирован лексикографически по `entityId`. Конструкт: `.sort((left, right) => left.entityId.localeCompare(right.entityId))`. Тест не указан.
