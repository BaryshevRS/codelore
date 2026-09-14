# startStdioServer

```ts
startStdioServer(options: { rootDir: string }): Promise<void>
```

## Зачем это нужно

Точка входа для подключения MCP-сервера Codelore к stdio-транспорту, делая инструменты и ресурсы документации доступными через stdin/stdout.

## Что делает

- Создаёт экземпляр MCP-сервера через [`createCodeloreServer`](create-server.codelore.md#createcodeloreserver) с переданным `rootDir`.
- Подключает созданный сервер к `StdioServerTransport`, после чего сервер обрабатывает сообщения через stdin/stdout.
- Не управляет жизненным циклом сервера после подключения — `server.connect` остаётся активным до завершения процесса.
- Не поддерживает другие транспортные протоколы — всегда использует `StdioServerTransport`.

## На что можно положиться

- При каждом вызове создаётся новый экземпляр сервера через [`createCodeloreServer`](create-server.codelore.md#createcodeloreserver); состояние между вызовами не разделяется.
- Всегда вызывает `server.connect(transport)` сразу после создания сервера.
- Функция асинхронная — возвращает `Promise<void>`, который разрешается при успешном подключении или отклоняется при ошибке подключения.

## От чего зависит

- [`createCodeloreServer`](create-server.codelore.md#createcodeloreserver) (`src/server/create-server.ts`) — создаёт и настраивает экземпляр `McpServer` с зарегистрированными ресурсами и инструментами.
- `StdioServerTransport` (`@modelcontextprotocol/server`) — транспорт, который читает JSON-RPC сообщения из stdin и пишет ответы в stdout.

## Кто и как использует

1. CLI-утилита [`src/cli/run-cli.ts`](../cli/run-cli.codelore.md) вызывает `startStdioServer` при команде `mcp`, передавая `rootDir` из разобранных глобальных аргументов.
2. Функция создаёт сервер через [`createCodeloreServer(options)`](create-server.codelore.md#createcodeloreserver) — на этом этапе регистрируются все ресурсы и инструменты.
3. Создаётся `StdioServerTransport`, и сервер подключается к нему вызовом `server.connect(transport)`, после чего начинает обрабатывать JSON-RPC сообщения через stdin/stdout.

## Чего не делает

- Не обрабатывает сигналы завершения процесса — после `server.connect` управление не возвращается до закрытия транспорта.
- Не поддерживает другие транспорты — `StdioServerTransport` жёстко задан в теле функции.
