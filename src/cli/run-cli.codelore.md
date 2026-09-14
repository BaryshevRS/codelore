# runCli

```ts
runCli(argv: string[], runtime: CliRuntime): Promise<number>
```

## Зачем это нужно

Точка входа CLI, объединяющая парсинг глобальных аргументов, диспетчеризацию команд и обработку ошибок с возвратом кода выхода.

## Что делает

- Если команда `help`, `--help` или `-h` — выводит справочный текст и возвращает 0, не обрабатывая остальные опции.
- Если команда `mcp`, запускает [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver) и возвращает 0, не создавая [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice).
- Для всех остальных команд создаётся [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) и выполняется `runCommand`, который проверяет аргументы, выполняет метод сервиса и возвращает результат; результат (не `undefined`) сериализуется в JSON и пишется в stdout.
- При любом исключении ошибка через [`toCodeloreErrorPayload`](../errors.codelore.md#tocodeloreerrorpayload) записывается в stderr и возвращается 1; при успехе, если результат содержит непустые `failed` или `issues`, возвращается 2, иначе 0.

runCli всегда сериализует результат работы команды как JSON в stdout, ошибки — в stderr, и возвращает один из трёх кодов выхода: 0, 1, 2.

## На что можно положиться

- При пустом `argv` (аргументов нет) команда подразумевается `help`: выводится справочный текст, возвращается 0.
- Код возврата детерминирован: 0 при успехе, 1 при любом исключении, 2 при налии в резултате непустого масива `failed` или `issues`.
- Резултат комманды (не `undefined`) всегда выводится в stdout как отформатированный JSON с двумя пробелами отступа.
- Каждое неперехваченное исключение выводится в stderr в виде `{ ok: false, error: <toCodeloreErrorPayload> }`.
- Запуск `mcp` не порождает вывода в stdout, не требует [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) и завершается только после остаовки сервера.

Гарантирует детерминированный код возврата: 0 при успехе, 1 при исключении, 2 при непустых `failed` или `issues`, и всегда записывает ошибку в stderr как `{ ok: false, error: ... }`.

## От чего зависит

runCli использует три внешних модуля: [`toCodeloreErrorPayload`](../errors.codelore.md#tocodeloreerrorpayload) из `src/errors.ts` — сериализует перехваченные исключения в JSON для вывода в `stderr`; [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver) из `src/server/start-stdio-server.ts` — запускает MCP-сервер для команды `mcp`; [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) из `src/service/codelore-service.ts` — предоставляет методы для всех остальных команд (делегируется через `runCommand`).

## Кто и как использует

Два бинарных файла вызывают `runCli`:
- `src/bin/codelore.ts` передаёт `process.argv.slice(2)` и `runtime` с `cwd`, `env`, `stdout`, `stderr`; после возврата присваивает `process.exitCode`.
- `src/bin/codelore-mcp.ts` делает то же самое, но предваряет аргументы командой `"mcp"`, поэтому `runCli` сразу переходит к запуску [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver).

Внутри `runCli`:
1. `parseGlobalArgs` извлекает `--root` (или `cwd` по умолчанию), `--provider` и команду; при отсутствии команды по умолчанию `help`.
2. Если команда `help`, `--help` или `-h` — выводит `helpText()` в `stdout` и возвращает 0.
3. Если команда `mcp` — вызывает [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver) и после его успешного завершения возвращает 0.
4. Для остальных команд создаётся [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice), вызывается `runCommand`, который проверяет аргументы через `assertExpectedArgs`, парсит специфичные аргументы и вызывает соответствующий метод сервиса.
5. Результат (если не `undefined`) сериализуется в JSON с отступами и выводится в `stdout`.
6. Если в результате есть непустые `failed` или `issues` (проверка `isUnclean`), возвращается 2, иначе 0.
7. Любое исключение перехватывается, сериализуется через [`toCodeloreErrorPayload`](../errors.codelore.md#tocodeloreerrorpayload) и выводится в `stderr` как JSON с полями `{ ok: false, error: ... }`, возвращается 1.

## Чего не делает

- Команда `mcp` блокирует процесс навсегда — конструкция `await startStdioServer({ rootDir: parsed.rootDir })` без таймаута или graceful shutdown.
- Нет поддержки конфигурационных файлов — параметры `--root` и `--provider` читаются только из CLI-аргументов.
- Обрабатывается только девят команд — `switch` в `runCommand` покрывает эти случаи; остальное выдает сообщеные об ошибке.

## Как менять и что проверять

- Формат вывода ошибки в stderr фиксирован: JSON с полями `ok` и `error`. Конструкция: `runtime.stderr.write(\`${JSON.stringify({ ok: false, error: toCodeloreErrorPayload(error) }, null, 2)}\n\`)`.
- Код возврата для успеха (0), исключения (1), и наличия непустых `failed` или `issues` (2) зафиксирован. Конструкции: `return 0;`, `return 1;`, `return 2;` в соответствующих ветвях.
