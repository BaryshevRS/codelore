# parseJsonObject

```ts
parseJsonObject(content: string, message: string): Record<string, unknown>
```

## Зачем это нужно

Точка входа для парсинга JSON-ответа LLM.

## Что делает

- Удаляет внешний Markdown-фенс (```json или ```) через `stripOuterFence`.
- Пытается распарсить результат стандартным `JSON.parse`; при успехе проверяет, что результат — объект, через `asJsonObject`.
- При неудаче первого парсинга применяет `repairKnownLlmEscapes` (исправляет экранированные `` ` ``, `$` и `\.`) и повторяет попытку.

## На что можно положиться

- Всегда возвращает `Record<string, unknown>` (не массив, не null, не примитив).
- При неудаче парсинга выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE`.
- Valid JSON никогда не проходит через `repairKnownLlmEscapes`.
- Внутренняя проверка `asJsonObject` выбрасывает обычный `Error`, который перехватывается и оборачивается в CodeloreError.

## От чего зависит

CodeloreError ([src/errors.ts](../errors.codelore.md)) — единый формат ошибок с машинно-читаемым кодом для всех компонентов Codelore.

## Кто и как использует

1. [`parseVerifyResponse`](doc-verifier.codelore.md#parseverifyresponse) (src/llm/doc-verifier.ts) вызывает `parseJsonObject` для парсинга ответа верификатора, затем извлекает поле `contradictions`.
2. [`parseFileWriteResponse`](file-writer.codelore.md#parsefilewriteresponse) (src/llm/file-writer.ts) вызывает `parseJsonObject` для парсинга ответа записи файла, затем проверяет структуру `sections`.
3. [`src/llm/translator.ts`](translator.codelore.md) импортирует `parseJsonObject` для парсинга ответов переводчика.

## Чего не делает

repairKnownLlmEscapes заменяет только три паттерна (`` \` ``, `\$`, `\.`). Если первый JSON.parse выбрасывает исключение, второй парсинг применяет repairKnownLlmEscapes, что может исказить корректные экранирования, не связанные с этими паттернами.

## Как менять и что проверять

1. Инвариант «Всегда возвращает Record<string, unknown>» enforce-ится выражением `throw new Error("not an object")` в функции `asJsonObject`.
2. Инвариант «При неудаче парсинга выбрасывает CodeloreError с кодом INVALID_LLM_RESPONSE» enforce-ится выражением `throw new CodeloreError("INVALID_LLM_RESPONSE", message, { cause: error instanceof Error ? error.message : String(error), response: content.slice(0, 1000), })`.

# readOptionalString

## Зачем это нужно

Безопасное извлечение опциональных строковых полей из разобранного JSON-объекта с возвратом `undefined` при отсутствии или пустом значении.

## Что делает

- Не проверяет наличие поля — возвращает `undefined` при `undefined`/`null`.
- Не преобразует типы — если значение присутствует, оно должно быть строкой, иначе выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE`.
- Не валидирует содержимое строки, кроме удаления пробелов с краёв.

## На что можно положиться

- Возвращает `undefined` только если поле отсутствует, равно `undefined`/`null`, или после `trim` пусто.
- Возвращает строку (trimmed) с длиной > 0, если поле — строка.
- Если значение не строка — выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `INVALID_LLM_RESPONSE`.

## Кто и как использует

Вызывается в [`src/llm/file-writer.ts`](file-writer.codelore.md) при разборе блоков секций для чтения опциональных строковых полей (например, метаданных). При отсутствии поля возвращается `undefined`, вызывающий решает, использовать значение по умолчанию или пропустить.

## Чего не делает

Не поддерживает вложенные поля — только прямой доступ `raw[field]`.
