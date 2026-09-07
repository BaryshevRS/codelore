# buildVerifyRequest

## Зачем это нужно

Собирает промпт для LLM, который запрашивает факт-чекинг блоков документации против переданного исходного кода и документации зависимостей.

## Что делает

- Не выполняет сам факт-чекинг — только строит запрос.
- Не валидирует входные `sections` и `dependencyDocs` — предполагает корректные данные от вызывающего.
- Не фильтрует `dependencyDocs` по релевантности — передаёт все полученные.
- Добавляет `typeContext` в промпт только при его наличии в `input`, иначе опускает соответствующую секцию.

## На что можно положиться

- Возвращаемый `ChatCompletionInput` всегда содержит ровно два сообщения: system и user.
- Строка `system.content` константна при всех вызовах.
- Промпт всегда включает секцию `<sections>` с JSON-сериализованными данными входных разделов.
- Секция `<dependency-docs>` в `user.content` присутствует только при непустом `dependencyDocs`.

## От чего зависит

Импортирует тип `ChatCompletionInput` из [`src/llm/provider.ts`](provider.codelore.md) и тип `DependencyDoc` из [`src/llm/file-writer.ts`](file-writer.codelore.md). Не использует никакие другие внешние модули во время выполнения — все остальные импорты файла относятся к другим функциям.

## Кто и как использует

Вызывается из [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts) (статическая, `src/llm/file-pipeline.ts`), [`verifyBlocksAgainstDeps`](file-pipeline.codelore.md#verifyblocksagainstdeps) (статическая, там же) и `buildRepairRequest` (там же, с `runtimeEvidence` совпадающей строки инструкции "Return only valid JSON. Do not include Markdown fences."). Построенный `ChatCompletionInput` передаётся в `provider.complete`. Промпт собирается для каждого файла отдельно в цикле по `fileTargets` внутри [`verifyBlocksAgainstDeps`](file-pipeline.codelore.md#verifyblocksagainstdeps).

## Чего не делает

- Не валидирует входные массивы `sections`, `dependencyDocs` и `typeContext` — пустые массивы принимаются и передаются в промпт, что может привести к пустому запросу без блоков.
- Промпт требует от LLM возврата строго JSON без Markdown-ограждений; любое отклонение от этого формата вызовет ошибку парсинга.

# parseVerifyResponse

## Зачем это нужно

Извлекает массив противоречивых утверждений из JSON-ответа LLM, отфильтровывая записи, не соответствующие проверяемым блокам документации.

## Что делает

- Не проверяет полноту охвата — LLM может пропустить часть блоков.
- Не валидирует `evidence` — только извлекает как строку.
- Игнорирует записи с `sectionId` или `blockId`, не входящими в переданные `sections` — считает их шумом модели.
- Выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE`, если `contradictions` не является массивом.

## На что можно положиться

- Возвращает только утверждения, чьи `sectionId` и `blockId` присутствуют в переданных `sections`.
- Если `contradictions` отсутствует или равен `null`, возвращает пустой массив.
- Если элемент массива `contradictions` не является объектом с строковыми полями `sectionId`, `blockId`, `statement`, он молча пропускается.
- Если `contradictions` — не массив, выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE`.

## От чего зависит

- `src/errors.ts` — [`CodeloreError`](../errors.codelore.md#codeloreerror) для выбрасывания исключения при невалидном формате поля `contradictions` (не массив).
- `src/llm/json.ts` — [`parseJsonObject`](json.codelore.md#parsejsonobject) для первичного парсинга JSON из ответа LLM.

## Кто и как использует

Вызывается из [`verifyBlocksAgainstDeps`](file-pipeline.codelore.md#verifyblocksagainstdeps) и [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts) (оба в `src/llm/file-pipeline.ts`). В [`verifyBlocksAgainstDeps`](file-pipeline.codelore.md#verifyblocksagainstdeps) результат `parseVerifyResponse` преобразуется в `Set` sectionId, прошедших проверку. В [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts) возвращённые `ContradictedClaim` затем отображаются в `DocViolation` для ремонта.

## Чего не делает

- Не проверяет, что `evidence` содержит корректные ссылки на код — значение принимается как есть; если `evidence` не строка, присваивается пустая строка (`typeof evidence === "string" ? evidence : ""`).
- Фильтрация по `sectionId`/`blockId` работает только на основе переданных `sections`; если LLM вернула блок, отсутствующий в исходном запросе, он игнорируется, хотя может содержать полезную информацию.
- Не проверяет, что каждый элемент массива `contradictions` имеет все обязательные поля в правильном порядке — при отсутствии строковых `sectionId`, `blockId`, `statement` элемент молча пропускается.

## Как менять и что проверять

- Инвариант «при null/undefined contradictions возвращается пустой массив» обеспечивается конструкцией `if (raw === undefined || raw === null) { return []; }`.
- Инвариант «элементы с нестроковыми sectionId/blockId/statement молча пропускаются» обеспечивается проверкой `if (typeof sectionId !== "string" || typeof blockId !== "string" || typeof statement !== "string") { continue; }`.
- Инвариант «запись с sectionId/blockId, отсутствующими в переданных sections, отфильтровывается» обеспечивается конструкцией `if (!blocksBySection.get(sectionId)?.has(blockId as BlockId)) { continue; }`.
