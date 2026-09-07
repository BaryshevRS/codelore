---
title: createConfiguredProvider
---

## Зачем это нужно

Точка входа для создания настроенного LLM-провайдера по имени из конфигурации, с разрешением имени по умолчанию и валидацией существования.

## Что делает

* Разрешает имя провайдера через `providerName ?? config.llm.provider`.
* Валидирует наличие конфигурации для разрешённого имени в `config.llm.providers`, при отсутствии бросает [`CodeloreError("UNKNOWN_LLM_PROVIDER")`](/docs/src/errors#codeloreerror).
* Делегирует создание `ChatCompletionProvider` внутренней функции `createProvider`, передавая ей имя, конфигурацию и runtime.
* Предоставляет точку входа для внешних вызывающих, не управляя временем жизни возвращённого объекта и не обрабатывая ошибки вызова LLM — эти обязанности лежат на `OpenAiCompatibleProvider.complete`.

## На что можно положиться

* Бросает [`CodeloreError("UNKNOWN_LLM_PROVIDER")`](/docs/src/errors#codeloreerror), если `providerName` или `config.llm.provider` не найден в `config.llm.providers`.
* Для любого валидного имени возвращает объект, реализующий `ChatCompletionProvider`.
* Не модифицирует `config` и `runtime`.

## От чего зависит

* [`CodeloreError`](/docs/src/errors#codeloreerror) (`src/errors.ts`) — для структурированной ошибки при отсутствии конфигурации провайдера.

## Кто и как использует

Вызывается из `CodeloreService.gateDepDocsCascade`, [`CodeloreService.runPipelineForSections`](/docs/src/service/codelore-service#runpipelineforsections) и [`CodeloreService.translateScope`](/docs/src/service/codelore-service#codeloreservicetranslatescope) во время генерации документации. Каждый вызывающий передаёт `runtime.providerName`, `runtime.env` и `runtime.fetch`. Функция разрешает имя провайдера, проверяет наличие конфигурации в `config.llm.providers` и делегирует создание провайдера в `createProvider`. Возвращённый `ChatCompletionProvider` используется в каждом из этих методов для соответствующих этапов генерации. Порядок выполнения не гарантирован, так как вызовы идут из разных этапов пайплайна.

## Чего не делает

Поддерживает только провайдеры с типом `"openai-compatible"`; для других типов выбрасывает [`CodeloreError("UNKNOWN_LLM_PROVIDER")`](/docs/src/errors#codeloreerror) через вызов `createProvider`. Ограничение накладывается внутренней функцией `createProvider`, которая проверяет `config.type === "openai-compatible"` и выбрасывает ошибку для других типов.

## Как менять и что проверять

1. Разрешение имени провайдера: инвариант закреплён в строке `const name = providerName ?? config.llm.provider;`. 2. Валидация наличия конфигурации: инвариант закреплён в проверке `if (!providerConfig) { throw new CodeloreError("UNKNOWN_LLM_PROVIDER", ...) }`.
