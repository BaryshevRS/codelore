# runCli

## Зачем это нужно

Точка входа CLI, объединяющая парсинг глобальных аргументов, диспетчеризацию команд и обработку ошибок с возвратом кода выхода.

## Что делает

- Не выполняет бизнес-логику команд — делегирует [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) или [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver).
- Не управляет MCP-сервером после запуска — [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver) управляет своим жизненным циклом.
- Не валидирует аргументы каждой команды — это делают `assertExpectedArgs` и `parse*` функции.
- Форматирует вывод: сериализует результат в JSON с отступами и выводит в `stdout`.

## На что можно положиться

- Всегда возвращает 0 при успешном выполнении, 1 при непредвиденной ошибке, 2 при наличии секций с `failed` в результате.
- Любое исключение перехватывается и выводится в `stderr` как JSON с полями `ok: false` и `error` через [`toCodeloreErrorPayload`](../errors.codelore.md#tocodeloreerrorpayload).
- Результат (если не `undefined`) выводится в `stdout` как JSON.

## От чего зависит

runCli использует три внешних модуля: [`toCodeloreErrorPayload`](../errors.codelore.md#tocodeloreerrorpayload) из `src/errors.ts` — сериализует перехваченные исключения в JSON для вывода в `stderr`; [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver) из `src/server/start-stdio-server.ts` — запускает MCP-сервер для команды `mcp`; [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) из `src/service/codelore-service.ts` — предоставляет методы для всех остальных команд (делегируется через `runCommand`).

## Кто и как использует

Файл `src/bin/codelore.ts` вызывает `runCli`, передавая `process.argv.slice(2)` и объект `runtime` с `cwd`, `env`, `stdout`, `stderr`. После возврата `process.exitCode` устанавливается в результат `runCli`.

Внутри `runCli`:
1. `parseGlobalArgs` извлекает `--root` (или `cwd` по умолчанию), `--provider` и команду; при отсутствии команды по умолчанию `help`.
2. Если команда `help` или `--help`/`-h` — выводит `helpText()` в `stdout` и возвращает 0.
3. Если команда `mcp` — вызывает [`startStdioServer`](../server/start-stdio-server.codelore.md#startstdioserver) и после его успешного завершения возвращает 0.
4. Для остальных команд создаётся [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice), вызывается `runCommand`, который проверяет аргументы через `assertExpectedArgs`, парсит специфичные аргументы (через `parseScope`, `parseAnalyzeChangeInput`, `parseRefreshStaleDocsInput`) и вызывает соответствующий метод сервиса.
5. Результат (если не `undefined`) сериализуется в JSON с отступами и выводится в `stdout`.
6. Если в результате есть секции с `failed` (проверка `hasFailedSections`), возвращается 2, иначе 0.
7. Любое исключение перехватывается, сериализуется через [`toCodeloreErrorPayload`](../errors.codelore.md#tocodeloreerrorpayload) и выводится в `stderr` как JSON с полями `{ ok: false, error: ... }`, возвращается 1.

## Чего не делает

- Команда `mcp` блокирует процесс навсегда — конструкция `await startStdioServer({ rootDir: parsed.rootDir })` без таймаута или graceful shutdown.
- Для `graph --html` путь вывода фиксирован: `join(parsed.rootDir, '.codelore', 'render-graph', 'index.html')`, без опции переопределения.
- Нет поддержки конфигурационных файлов — параметры `--root` и `--provider` читаются только из CLI-аргументов.
- Обрабатывается только девять команд — `switch` в `runCommand` покрывает эти случаи; остальное выдаёт сообщение об ошибке.

## Как менять и что проверять

- Формат вывода ошибки в stderr фиксирован: JSON с полями `ok` и `error`. Конструкция: `runtime.stderr.write(\`\${JSON.stringify({ ok: false, error: toCodeloreErrorPayload(error) }, null, 2)}\n\`)`.
- Код возврата для успеха (0), исключения (1), и наличия секций с `failed` (2) зафиксирован. Конструкции: `return 0;`, `return 1;`, `return 2;` в соответствующих ветвях.
