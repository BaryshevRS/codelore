# startStdioServer

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

## Кто и как использует

1. Прямой вызов из `file:src/bin/codelore-mcp.ts` через `#!/usr/bin/env node` — запускается как CLI-утилита с `rootDir: process.cwd()`.
2. Вызов из `symbol:src/cli/run-cli.ts#runCli` при значении `parsed.command === "mcp"` — передаётся `rootDir` из разобранных глобальных аргументов.
3. [`createCodeloreServer`](create-server.codelore.md#createcodeloreserver) создаёт сервер и регистрирует ресурсы, затем `StdioServerTransport` подключается через `server.connect(transport)`, после чего сервер начинает обработку сообщений через stdin/stdout.
