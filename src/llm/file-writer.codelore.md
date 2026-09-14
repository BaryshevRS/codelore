# buildFileWriteRequest

```ts
buildFileWriteRequest(input: BuildFileWriteRequestInput): ChatCompletionInput
```

## Зачем это нужно

Упаковывает исходный код, секции документации и dependency docs в структурированный запрос для LLM.

## Что делает

- Формирует системное сообщение с фиксированным набором правил документирования.
- Собирает пользовательское сообщение, объединяя языковое правило, правило намерения, правила блоков, описание формата JSON, контекст проекта, термины, dependency docs, исходные файлы и секции; пустые опциональные части опускаются.
- Генерирует схему ответа на основе переданных секций.
- Возвращает `ChatCompletionInput` с ровно двумя сообщениями: системным и пользовательским.

## На что можно положиться

- Возвращаемый объект всегда содержит массив `messages` длиной 2.
- Системное сообщение содержит неизменный набор правил документирования.
- Пользовательское сообщение собирается из входных данных; пустые опциональные части (projectContext, terms, dependencyDocs) опускаются.
- Схема ответа (`responseSchema`) детерминированно строится из переданных секций.
- Не изменяет входные объекты.

## От чего зависит

Использует локальные хелперы `blockRules`, `writingRulesSegment` и `sectionsForPrompt` из этого же файла для сборки текста правил и сериализации секций. Тип `ChatCompletionInput` импортирован из [`src/llm/provider.ts`](provider.codelore.md). Для формирования схемы ответа вызывает `fileWriteResponseSchema`.

## Кто и как использует

Вызывается из [`writeRequestOverheadChars`](#writerequestoverheadchars) (этот же файл) с пустыми `files` и `sections` для подсчёта символов общего префикса промпта. В `generateFileGroup` ([src/llm/file-pipeline.ts](file-pipeline.codelore.md)) формирует полный запрос для LLM-генерации документации, после чего результат разбивается на чанки и отправляется провайдеру. В `buildVerifyRequest` ([src/llm/doc-verifier.ts](doc-verifier.codelore.md)) и `buildRepairRequest` (src/llm/file-pipeline.ts) не используется — они строят запросы напрямую. `buildDomainWriteRequest` ([src/llm/domain-writer.ts](domain-writer.codelore.md#domain-writerts)) и `translator.ts` также не вызывают эту функцию.

## Чего не делает

Не контролирует размер `projectContext` — он вставляется целиком через `writingRulesSegment(input.projectContext)`. `dependencyDocs` сериализуются через `JSON.stringify(input.dependencyDocs, null, 2)` без ограничения длины. Исходные файлы и секции передаются полностью — разбиение на части выполняется снаружи. Поддерживает только текстовые сообщения: `messages[0].content` и `messages[1].content` всегда строки.

# parseFileWriteResponse

```ts
parseFileWriteResponse(content: string, sections: FileWriteSection[], options: { requireCompleteness?: boolean } = {}): FileWriteResult
```

## Зачем это нужно

Разбирает JSON-ответ LLM в структурированный `FileWriteResult`, проверяя соответствие ожидаемым секциям и блокам.

## Что делает

- Разбирает JSON-ответ LLM, проверяет наличие объекта `sections` и соответствие идентификаторов секций ожидаемым.
- Для каждой секции делегирует валидацию и парсинг блоков функциям `parseSectionBlocks` и `parseWrittenBlock`, которые проверяют типы, обязательные поля и допустимые значения оценок.
- При `requireCompleteness: true` (по умолчанию) проверяет наличие обязательных блоков `purpose` и `responsibility` через `assertRequiredBlocks`.
- Возвращает `FileWriteResult`; при любом нарушении структуры выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE`.

## На что можно положиться

- Бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE` при любом нарушении структуры ответа.
- Опция `requireCompleteness: true` (по умолчанию) гарантирует, что все обязательные блоки (`purpose`, `responsibility`) присутствуют; при `false` пропускает проверку.
- Неизвестные `sectionId` в ответе LLM вызывают ошибку, а не игнорируются.

## От чего зависит

Зависит от [`parseJsonObject`](json.codelore.md#parsejsonobject) (src/llm/json.ts) для разбора JSON и от [`CodeloreError`](../errors.codelore.md#codeloreerror) (src/errors.ts) для структурированных ошибок. Внутренняя валидация выполняется функциями `parseSectionBlocks`, `parseWrittenBlock`, `readRefs`, `readScore` и `assertRequiredBlocks`, определёнными в том же файле.

## Кто и как использует

Вызывается из [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts) в `file-pipeline.ts` с опцией `requireCompleteness: false` — это позволяет пропустить необязательные блоки при ремонте. Результат (`FileWriteResult`) передаётся в `mergeRepairedBlocks` для слияния с уже записанной документацией.

## Чего не делает

Константа `REQUIRED_TARGET_BLOCKS` содержит только `"purpose"` и `"responsibility"` — остальные блоки не обязательны даже при `requireCompleteness: true`. Множество `ALLOWED_SCORE_VALUES` фиксировано пятью значениями: 0, 0.25, 0.5, 0.75, 1. Неизвестные `sectionId` приводят к ошибке, а не к игнорированию — проверка выполняется через `if (unknown.length > 0)`. Строгая проверка рефов в `readRefs` (массив строк) выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) при несоответствии.

## Как менять и что проверять

- Набор обязательных блоков зафиксирован в `REQUIRED_TARGET_BLOCKS` — вызов `REQUIRED_TARGET_BLOCKS.has(blockId)` в `assertRequiredBlocks` определяет, какие блоки обязательны при `requireCompleteness: true`.
- Допустимые значения оценок перечислены в `ALLOWED_SCORE_VALUES` — проверка `ALLOWED_SCORE_VALUES.has(value)` в `readScore` выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) при любом отклонении.
- Формат `refs` проверяется в `readRefs` условием `value.some((entry) => typeof entry !== "string")` — массив должен содержать только строки.

# writeRequestOverheadChars

## Зачем это нужно

Вычисляет количество символов в общем префиксе промпта (правила, контекст проекта, dependency docs), который повторяется в каждом чанке группы, чтобы чанкер мог вычесть его из бюджета модели перед определением размера исходного кода на чанк.

## Что делает

- Делегирует построение запроса функции [`buildFileWriteRequest`](#buildfilewriterequest), передавая пустые массивы `files` и `sections`.
- Суммирует длины содержимого всех сообщений полученного запроса через `reduce`.
- Возвращает общее количество символов как число.

## На что можно положиться

- Всегда возвращает неотрицательное целое число.
- Не мутирует входной объект.
- Результат детерминирован при одинаковых входных данных.

## От чего зависит

Зависит от [`buildFileWriteRequest`](#buildfilewriterequest) (src/llm/file-writer.ts) для построения полного промпта с пустыми массивами `files` и `sections` с целью последующего подсчёта символов.

## Кто и как использует

Вызывается из [`generateFileGroup`](file-pipeline.codelore.md#generatefilegroup) в `file-pipeline.ts` перед планированием чанков. Параметры: `dependencyDocs`, `projectContext`, `terms`, `language`, `intent`. Возвращает количество символов общего префикса, которое вычитается из бюджета модели для каждого чанка.
