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

Вызывается из [`startStdioServer`](start-stdio-server.codelore.md#startstdioserver) (`src/server/start-stdio-server.ts`), который ожидает Promise и только после получения сервера запускает stdio-транспорт MCP. К моменту разрешения Promise сервер уже полностью сконфигурирован: внутри вызова создаётся CodeloreService, собираются baseInstructions, конструируется McpServer и вызываются registerResources с registerTools.

## Чего не делает

- Сигнатура принимает только `rootDir`; параметры транспорта, модели или порта не предусмотрены — ограничение типа `options: { rootDir: string }`.
- baseInstructions фиксируют документированную область: `.codelore.md` — рендер-артефакты, которые нельзя редактировать вручную, а сервер выполняет полный LLM-конвейер сам, не выставляя нижнеуровневые шаги перезаписи.

## Как менять и что проверять

- Сервер всегда создаётся с доменными инструкциями: конструкция `instructions: baseInstructions` в параметрах McpServer.
- Функция всегда завершается возвратом собранного сервера: `return server;`.
- Идентификаторы секций всегда кодируются перед встраиванием в URI ресурса: `doc://section/${encodeResourceId(section.id)}`.
- Обработчики инструментов всегда обёрнуты в защитный слой нормализации ошибок: `safely(() => service.generateDocsForScope(input, generateRuntime("document")))`.
