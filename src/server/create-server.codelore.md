# createCodeloreServer

```ts
createCodeloreServer(options: { rootDir: string }): Promise<McpServer>
```

## Зачем это нужно

Точка входа для создания MCP-сервера Codelore с полной настройкой ресурсов, инструментов и навыков.

## Что делает

- Делегирует все операции с документацией сервису [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice).
- Не управляет транспортом и соединением — возвращает настроенный `McpServer`.
- Регистрирует ресурсы и инструменты через локальные функции `registerResources` и `registerTools`.
- При наличии `projectContext` регистрирует ресурс `context://project` через `registerProjectContextResource`.

## На что можно положиться

- Имя сервера всегда `"codelore"` (жёстко задано в первом аргументе конструктора `McpServer`).
- Версия извлекается из `package.json` через `createRequire` при загрузке модуля; между вызовами функции не меняется.
- Каждый вызов создаёт отдельный экземпляр [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) — состояние документации между серверами не разделяется.
- Инструкции сервера (`instructions`) всегда содержат неизменный текст `baseInstructions`, описывающий полный пайплайн.
- К моменту возврата `McpServer` все ресурсы и инструменты уже зарегистрированы вызовами `registerResources` и `registerTools`; сервер готов к подключению.
- Ошибки конструктора `McpServer` или функций регистрации не перехватываются и пробрасываются вызывающему коду.

## От чего зависит

- [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) (`src/service/codelore-service.ts`) — центральный сервис для индексации, генерации и обновления документации, включая тип `GenerateDocsRuntime`.

## Кто и как использует

Вызывается функцией [`startStdioServer`](start-stdio-server.codelore.md#startstdioserver) (`src/server/start-stdio-server.ts`):
1. [`startStdioServer`](start-stdio-server.codelore.md#startstdioserver) вызывает `createCodeloreServer({ rootDir })` и ожидает возврата `McpServer`.
2. Внутри `createCodeloreServer` создаётся экземпляр `new CodeloreService(rootDir)`, определяется строка `baseInstructions`, создаётся `new McpServer` с именем `"codelore"` и версией из `package.json`.
3. Вызываются `registerResources` и `registerTools`, которые регистрируют пять ресурсов (`doc-section`, `code-entity`, `impact-graph`, `change-analysis`, `doc-file`) и четыре инструмента (`document`, `update`, `mark_stale`, `check`).
4. Сервер возвращается.
5. [`startStdioServer`](start-stdio-server.codelore.md#startstdioserver) создаёт `StdioServerTransport` и вызывает `server.connect(transport)`.

## Чего не делает

- Не проверяет существование `rootDir`; ошибки ввода-вывода возникают только при первом обращении к методам [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) (конструкция: отсутствие guards).
- Ошибки при регистрации ресурсов или инструментов не перехватываются; исключение в `registerResources` или `registerTools` вызывает необработанное отклонение промиса (конструкция: отсутствие `try-catch`).

## Как менять и что проверять

- Сервис [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) всегда создаётся с параметром `rootDir` из аргументов, что гарантируется вызовом `new CodeloreService(options.rootDir)`. Изменение параметров вызова изменит корневую директорию сервера.
- Функция всегда возвращает новый экземпляр `McpServer`, так как оператор `return server;` выполняется без условной логики или кэширующего механизма. Изменение этой строки на условный возврат или кэш повлияет на поведение вызова.
