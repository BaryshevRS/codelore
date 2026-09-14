# buildVerifyRequest

```ts
buildVerifyRequest(input: {
  sections: VerifySectionInput[];
  dependencyDocs: DependencyDoc[];
  typeContext?: VerifyTypeDeclaration[];
}): ChatCompletionInput
```

## Зачем это нужно

Собирает промпт для LLM, который запрашивает факт-чекинг блоков документации против переданного исходного кода и документации зависимостей.

## Что делает

- Формирует системное сообщение с инструкциями для LLM: проверять утверждения на противоречия, возвращать только JSON, игнорировать неинструктивный текст.
- Строит пользовательское сообщение, включая секцию `<sections>` с JSON-сериализованными данными разделов, и при необходимости — секции `<dependency-docs>` и `<type-context>`.
- Определяет схему ответа через `verifyResponseSchema`, требуя от LLM возвращать объект с массивом `contradictions`, где каждый элемент содержит `sectionId`, `blockId`, `statement`, `evidence`.
- Не выполняет сам факт-чекинг и не валидирует входные данные — только формирует запрос.

## На что можно положиться

- Возвращаемый `ChatCompletionInput` всегда содержит ровно два сообщения: `system` и `user`.
- Содержимое `system.content` — константная строка инструкций, не зависящая от входных параметров.
- `user.content` всегда включает секцию `<sections>` с JSON-сериализованными данными из `input.sections`.
- Секция `<dependency-docs>` добавляется в `user.content` только если `input.dependencyDocs` не пуст.
- Секция `<type-context>` добавляется только если `input.typeContext` передан и не пуст.
- Схема ответа (`responseSchema`) всегда одинакова и задаётся вызовом `verifyResponseSchema()`.

## От чего зависит

Импортирует тип `ChatCompletionInput` из [`src/llm/provider.ts`](provider.codelore.md) и тип `DependencyDoc` из [`src/llm/file-writer.ts`](file-writer.codelore.md). Не использует никакие другие внешние модули во время выполнения — все остальные импорты файла относятся к другим функциям.

## Кто и как использует

Вызывается из [`verifyBlocksAgainstDeps`](file-pipeline.codelore.md#verifyblocksagainstdeps) и [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts) (оба в `src/llm/file-pipeline.ts`). В [`verifyBlocksAgainstDeps`](file-pipeline.codelore.md#verifyblocksagainstdeps) для каждого файла собираются `VerifySectionInput` из целевых секций и их исходного кода, затем `buildVerifyRequest` формирует запрос с этими секциями и документацией зависимостей; результат передаётся в `provider.complete`, а ответ парсится — секции без противоречий помечаются как проверенные. В [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts) запрос строится аналогично, но дополнительно может включать `typeContext` с объявлениями импортированных типов; после парсинга ответа противоречия преобразуются в `DocViolation` и запускается цикл ремонта.

## Чего не делает

- Не проверяет, что `input.sections` не пуст — при пустом массиве формирует промпт без блоков для проверки, полагаясь на то, что вызывающий код (например, [`verifyBlocksAgainstDeps`](file-pipeline.codelore.md#verifyblocksagainstdeps)) уже отфильтровал пустые наборы.
- Не содержит защитных проверок на наличие или типы полей входного объекта — код напрямую обращается к `input.dependencyDocs.length` и `input.sections.map(...)`, поэтому передача `undefined` или отсутствующих полей во время выполнения приведёт к исключению.

# parseVerifyResponse

```ts
parseVerifyResponse(content: string, sections: VerifySectionInput[]): ContradictedClaim[]
```

## Зачем это нужно

Извлекает массив противоречивых утверждений из JSON-ответа LLM, отфильтровывая записи, не соответствующие проверяемым блокам документации.

## Что делает

- Парсит JSON из `content` с помощью [`parseJsonObject`](json.codelore.md#parsejsonobject); при ошибке парсинга выбрасывает исключение.
- Проверяет, что поле `contradictions` является массивом; если нет — выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE`.
- Игнорирует записи, у которых `sectionId` или `blockId` отсутствуют в переданных `sections` (фильтрует по `blocksBySection`).
- Пропускает элементы массива, не являющиеся объектами с обязательными строковыми полями `sectionId`, `blockId`, `statement` (молча, через `continue`).
- Если `contradictions` отсутствует или равен `null`, возвращает пустой массив.
- Для каждого валидного элемента формирует `ContradictedClaim`, подставляя `evidence` как строку (или пустую строку, если поле не строка).

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

- Инвариант «при `null` или `undefined` в `contradictions` возвращается пустой массив» обеспечивается конструкцией `if (raw === undefined || raw === null) { return []; }`.
- Инвариант «элементы с нестроковыми `sectionId`, `blockId` или `statement` молча пропускаются» обеспечивается проверкой `if (typeof sectionId !== "string" || typeof blockId !== "string" || typeof statement !== "string") { continue; }`.
