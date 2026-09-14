# createConfiguredProvider

```ts
createConfiguredProvider(config: CodeloreConfig, providerName: string | undefined, runtime: ProviderRuntime): ChatCompletionProvider
```

## Зачем это нужно

Точка входа для создания настроенного LLM-провайдера по имени из конфигурации, с разрешением имени по умолчанию и валидацией существования.

## Что делает

- Вычисляет имя провайдера как `providerName ?? config.llm.provider`.
- Ищет конфигурацию в `config.llm.providers`; если записи нет, собирает `Object.keys(config.llm.providers)` и бросает [`CodeloreError("UNKNOWN_LLM_PROVIDER")`](../errors.codelore.md#codeloreerror) с сообщением, которое различает пустой реестр и неизвестное имя.
- При найденной конфигурации передаёт имя, конфигурацию и runtime в `createProvider` и возвращает полученный `ChatCompletionProvider`.

## На что можно положиться

- Если `providerName` задан, он имеет приоритет над `config.llm.provider`; если не задан, используется значение по умолчанию.
- Для имени, отсутствующего в `config.llm.providers`, всегда бросает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNKNOWN_LLM_PROVIDER`; `details.provider` равен выбранному имени, а `details.configuredProviders` — массив ключей реестра.
- Для существующего имени возвращает объект, реализующий `ChatCompletionProvider`, и не изменяет `config` или `runtime`.

## От чего зависит

- [`CodeloreError`](../errors.codelore.md#codeloreerror) (`src/errors.ts`) — для структурированной ошибки при отсутствии конфигурации провайдера.

## Кто и как использует

Вызывается из [`CodeloreService.createProviderPair`](../service/codelore-service.codelore.md#codeloreservicecreateproviderpair), [`CodeloreService.partitionDomainMap`](../service/codelore-service.codelore.md#codeloreservicepartitiondomainmap) и [`CodeloreService.translateScope`](../service/codelore-service.codelore.md#codeloreservicetranslatescope) при создании LLM-провайдера для генерации документации. Каждый вызывающий передаёт `runtime.providerName`, `runtime.env` и `runtime.fetch`. Функция разрешает имя провайдера как `providerName ?? config.llm.provider`, проверяет наличие конфигурации в `config.llm.providers` и делегирует создание провайдера в `createProvider`. Возвращённый `ChatCompletionProvider` используется вызывающими для выполнения запросов к LLM на соответствующих этапах пайплайна.

## Чего не делает

Поддерживает только провайдеры с типом `"openai-compatible"`; для других типов выбрасывает [`CodeloreError("UNKNOWN_LLM_PROVIDER")`](../errors.codelore.md#codeloreerror) через вызов `createProvider`. Ограничение накладывается внутренней функцией `createProvider`, которая проверяет `config.type === "openai-compatible"` и выбрасывает ошибку для других типов.

## Как менять и что проверять

- Разрешение имени провайдера: инвариант закреплён в строке `const name = providerName ?? config.llm.provider;`.
- Валидация наличия конфигурации: инвариант закреплён в проверке `if (!providerConfig) { throw new CodeloreError("UNKNOWN_LLM_PROVIDER", ...) }`.
