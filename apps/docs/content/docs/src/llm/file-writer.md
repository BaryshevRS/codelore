---
title: buildFileWriteRequest
---

## Зачем это нужно

Упаковывает исходный код, секции документации и dependency docs в структурированный запрос для LLM.

## Что делает

* Собирает системное сообщение с фиксированными правилами документирования и инструкцией возвращать JSON.
* Формирует пользовательское сообщение, включающее языковое правило, правило намерения, правила блоков, описание формата JSON, контекст проекта, предпочитаемые термины, dependency docs, исходные файлы и секции для документирования.
* Возвращает объект `ChatCompletionInput` с ровно одним системным и одним пользовательским сообщением.

## На что можно положиться

* Всегда возвращает объект с массивом `messages` длиной 2.
* Поле `messages[0].content` содержит неизменный набор правил.
* Поле `messages[1].content` включает `languageRule` и `intentRule`.
* Не мутирует входные массивы или объекты.

## От чего зависит

Зависит от внутренних функций `blockRules`, `writingRulesSegment` и `sectionsForPrompt`, определённых в том же файле, а также от типа `ChatCompletionInput` из [`src/llm/provider.ts`](/docs/src/llm/provider). Для сериализации использует `JSON.stringify` — внешние пакеты или error-классы не задействованы.

## Кто и как использует

Единственный подтверждённый вызывающий — [`writeRequestOverheadChars`](#writerequestoverheadchars) (этот же файл): он передаёт пустые `files` и `sections` для подсчёта символов общего префикса. Вызовы из `buildRepairRequest`, `translator.ts` и `doc-verifier.ts` не используют данную функцию — в их телах запрос строится напрямую.

## Чего не делает

* Значение `projectContext` вставляется целиком через `writingRulesSegment(input.projectContext)` без проверки или обрезки — размер не контролируется.
* `dependencyDocs` сериализуются через `JSON.stringify(input.dependencyDocs, null, 2)` без лимита на размер.
* Исходные файлы и секции передаются полностью, без разбивки — функция не производит чанкинг или трекинг.
* Поддерживаются только текстовые сообщения; мультимодальные запросы не реализованы: `messages[0].content` и `messages[1].content` всегда строки.

## parseFileWriteResponse

### Зачем это нужно

Разбирает JSON-ответ LLM в структурированный `FileWriteResult`, проверяя соответствие ожидаемым секциям и блокам.

### Что делает

* Не выполняет ретраи при невалидном ответе — это задача вызывающего (`file-pipeline.ts`).
* Не проверяет содержательную корректность блоков (например, правильность `refs`) — только наличие и структуру.
* Не отвечает за сериализацию ответа в секции документации — возвращает `FileWriteResult`.
* Делегирует парсинг каждого блока внутренним функциям (`parseWrittenBlock`, `readRefs`).

### На что можно положиться

* Бросает [`CodeloreError`](/docs/src/errors#codeloreerror) с кодом `INVALID_LLM_RESPONSE` при любом нарушении структуры ответа.
* Опция `requireCompleteness: true` (по умолчанию) гарантирует, что все обязательные блоки (`purpose`, `responsibility`) присутствуют; при `false` пропускает проверку.
* Неизвестные `sectionId` в ответе LLM вызывают ошибку, а не игнорируются.

### От чего зависит

Зависит от [`parseJsonObject`](/docs/src/llm/json#parsejsonobject) (src/llm/json.ts) для разбора JSON и от [`CodeloreError`](/docs/src/errors#codeloreerror) (src/errors.ts) для структурированных ошибок. Внутренняя валидация выполняется функциями `parseSectionBlocks`, `parseWrittenBlock`, `readRefs`, `readScore` и `assertRequiredBlocks`, определёнными в том же файле.

### Кто и как использует

Вызывается из [`verifyChunkFacts`](/docs/src/llm/file-pipeline#verifychunkfacts) в `file-pipeline.ts` с опцией `requireCompleteness: false` — это позволяет пропустить необязательные блоки при ремонте. Результат (`FileWriteResult`) передаётся в `mergeRepairedBlocks` для слияния с уже записанной документацией.

### Чего не делает

Константа `REQUIRED_TARGET_BLOCKS` содержит только `"purpose"` и `"responsibility"` — остальные блоки не обязательны даже при `requireCompleteness: true`. Множество `ALLOWED_SCORE_VALUES` фиксировано пятью значениями: 0, 0.25, 0.5, 0.75, 1. Неизвестные `sectionId` приводят к ошибке, а не к игнорированию — проверка выполняется через `if (unknown.length > 0)`. Строгая проверка рефов в `readRefs` (массив строк) выбрасывает [`CodeloreError`](/docs/src/errors#codeloreerror) при несоответствии.

### Как менять и что проверять

Добавление нового идентификатора в `REQUIRED_TARGET_BLOCKS` (конструкция `REQUIRED_TARGET_BLOCKS.has(blockId)`) вызовет ошибку в `assertRequiredBlocks` для всех существующих LLM-ответов, не содержащих этот блок. Изменение `ALLOWED_SCORE_VALUES` (проверка `ALLOWED_SCORE_VALUES.has(value)`) приведёт к ошибке в `readScore` при несовпадении. Формат `refs` строго `string[]` — любое отклонение вызывает [`CodeloreError`](/docs/src/errors#codeloreerror) через проверку `value.some((entry) => typeof entry !== "string")`.

## writeRequestOverheadChars

### Зачем это нужно

Вычисляет количество символов в общем префиксе промпта (правила, контекст проекта, dependency docs), который повторяется в каждом чанке группы, чтобы чанкер мог вычесть его из бюджета модели перед определением размера исходного кода на чанк.

### Что делает

* Делегирует построение запроса функции [`buildFileWriteRequest`](#buildfilewriterequest), передавая пустые массивы `files` и `sections`.
* Суммирует длины содержимого всех сообщений полученного запроса через `reduce`.
* Возвращает общее количество символов как число.

### На что можно положиться

* Всегда возвращает неотрицательное целое число.
* Не мутирует входной объект.
* Результат детерминирован при одинаковых входных данных.

### От чего зависит

Зависит от [`buildFileWriteRequest`](#buildfilewriterequest) (src/llm/file-writer.ts) для построения полного промпта с пустыми массивами `files` и `sections` с целью последующего подсчёта символов.

### Кто и как использует

Вызывается из [`generateFileGroup`](/docs/src/llm/file-pipeline#generatefilegroup) в `file-pipeline.ts` перед планированием чанков. Параметры: `dependencyDocs`, `projectContext`, `terms`, `language`, `intent`. Возвращает количество символов общего префикса, которое вычитается из бюджета модели для каждого чанка.
