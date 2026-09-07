# CodeloreError

## Зачем это нужно

Единый формат ошибок с машинно-читаемым кодом для всех компонентов Codelore.

## Что делает

- Предоставляет публичные поля `code` (тип `CodeloreErrorCode`) и `details` (опциональный объект) для машинно-читаемой обработки ошибок.
- Не занимается сериализацией ошибки в JSON, логированием, форматированием сообщений для пользователя или фильтрацией кодов — эти задачи вынесены в [`toCodeloreErrorPayload`](#tocodeloreerrorpayload) и вызывающий код.
- Позволяет другим модулям выбрасывать ошибки с фиксированным набором кодов, определённых в `CodeloreErrorCode`.

## На что можно положиться

- Всегда содержит валидный `code` из `CodeloreErrorCode`.
- `details` — опциональный объект, может быть `undefined`.
- Наследует `name`, `message`, `stack` от `Error`.

## Кто и как использует

1. Вызывающий код (например, [`src/cli/run-cli.ts`](cli/run-cli.codelore.md), [`src/indexer/state-indexer.ts`](indexer/state-indexer.codelore.md)) создаёт `CodeloreError` с кодом и сообщением при обнаружении ошибочной ситуации.
2. Верхний обработчик в `runCli` перехватывает ошибку и передаёт её в [`toCodeloreErrorPayload`](#tocodeloreerrorpayload) для сериализации в JSON-ответ.
3. Другие компоненты (например, [`src/llm/complete-and-parse.ts`](llm/complete-and-parse.codelore.md), [`src/service/codelore-service.ts`](service/codelore-service.codelore.md)) также выбрасывают `CodeloreError` при невалидных входных данных или внутренних сбоях.

## Чего не делает

- Не сериализует `stack` в `CodeloreErrorPayload`.
- Не поддерживает цепочку причин (chained errors) — `details` используется для дополнительных данных, не для вложенных ошибок.

# toCodeloreErrorPayload

## Зачем это нужно

Преобразует произвольную ошибку в структурированный `CodeloreErrorPayload` для сериализации в JSON.

## Что делает

- Не модифицирует исходную ошибку.
- Не логирует — только возвращает payload.
- Для ошибок не-[`CodeloreError`](#codeloreerror) всегда возвращает код `INTERNAL_ERROR`.

## На что можно положиться

- Всегда возвращает объект с полями `code` и `message`.
- Если `error` — [`CodeloreError`](#codeloreerror), включает `details` из него.
- Для всех остальных типов `code` равен `INTERNAL_ERROR`.

## От чего зависит

- [`CodeloreError`](#codeloreerror) (`src/errors.ts`) — проверка `instanceof` и доступ к `code` и `details`.

## Кто и как использует

Вызывается в [`runCli`](cli/run-cli.codelore.md#runcli) (`symbol:src/cli/run-cli.ts#runCli`) и `createCodeloreServer` (`file:src/server/create-server.ts`) в блоке `catch` для сериализации ошибки в JSON-ответ.

## Чего не делает

- Не включает `stack` в payload.
- Не обрабатывает циклические ссылки в `details` — при их наличии `JSON.stringify` может выбросить исключение.
