---
title: createCodeloreServer
---

## Зачем это нужно

Точка входа для создания MCP-сервера Codelore с полной настройкой ресурсов, инструментов и навыков.

## Что делает

* Делегирует все операции с документацией сервису [`CodeloreService`](/docs/src/service/codelore-service#codeloreservice).
* Не управляет транспортом и соединением — возвращает настроенный `McpServer`.
* Регистрирует ресурсы и инструменты через локальные функции `registerResources` и `registerTools`.
* При наличии `projectContext` регистрирует ресурс `context://project` через `registerProjectContextResource`.

## На что можно положиться

Имя сервера всегда "codelore", версия "0.1.0". При каждом вызове создаётся новый экземпляр CodeloreService; состояние между вызовами не разделяется. Инструкции сервера всегда содержат baseInstructions. Все ресурсы и инструменты зарегистрированы до возврата сервера.

## От чего зависит

* [`CodeloreService`](/docs/src/service/codelore-service#codeloreservice) (`src/service/codelore-service.ts`) — центральный сервис для индексации, генерации и обновления документации, включая тип `GenerateDocsRuntime`.

## Кто и как использует

Вызывается функцией [`startStdioServer`](/docs/src/server/start-stdio-server#startstdioserver) (`src/server/start-stdio-server.ts`):

1. [`startStdioServer`](/docs/src/server/start-stdio-server#startstdioserver) вызывает `createCodeloreServer({ rootDir })` и ожидает возврата `McpServer`.
2. Внутри `createCodeloreServer` создаётся экземпляр `new CodeloreService(rootDir)`, определяются инструкции `baseInstructions` как строковый литерал, создаётся `new McpServer` с именем `"codelore"` и версией `"0.1.0"`.
3. Регистрируются пять ресурсов (`doc-section`, `code-entity`, `impact-graph`, `change-analysis`, `doc-file`) и четыре инструмента (`document`, `update`, `mark_stale`, `check`) через функции `registerResources` и `registerTools`.
4. Сервер возвращается.
5. [`startStdioServer`](/docs/src/server/start-stdio-server#startstdioserver) создаёт `StdioServerTransport` и вызывает `server.connect(transport)`.

## Чего не делает

* Не проверяет существование `rootDir`; ошибки ввода-вывода возникают только при первом обращении к методам [`CodeloreService`](/docs/src/service/codelore-service#codeloreservice) (конструкция: отсутствие guards).
* Ошибки при регистрации ресурсов или инструментов не перехватываются; исключение в `registerResources` или `registerTools` вызывает необработанное отклонение промиса (конструкция: отсутствие `try-catch`).

## Как менять и что проверять

* Сервис [`CodeloreService`](/docs/src/service/codelore-service#codeloreservice) всегда создаётся с параметром `rootDir` из аргументов, что гарантируется вызовом `new CodeloreService(options.rootDir)`. Изменение параметров вызова изменит корневую директорию сервера.
* Функция всегда возвращает новый экземпляр `McpServer`, так как оператор `return server;` выполняется без условной логики или кэширующего механизма. Изменение этой строки на условный возврат или кэш повлияет на поведение вызова.
