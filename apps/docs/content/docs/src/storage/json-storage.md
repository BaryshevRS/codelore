---
title: JsonStorage
---

## Зачем это нужно

Сохранение и загрузка индексных данных и результатов анализа изменений в JSON-файлы.

## Что делает

* Создаёт директории при записи через `mkdir` с `recursive: true`.
* При отсутствии файла чтение возвращает `undefined`, а не выбрасывает исключение — обработка `ENOENT` в `readJson`.
* Пути к файлам вычисляются из конфигурации через `indexPath` и `changePath`.

## На что можно положиться

* При отсутствии файла чтение возвращает `undefined`, а не выбрасывает исключение.
* Запись всегда гарантирует существование целевой директории перед созданием файла.
* Пути к файлам детерминировано вычисляются из конфигурации и не зависят от состояния.

## Кто и как использует

1. [`CodeloreService`](/docs/src/service/codelore-service#codeloreservice) вызывает `saveProjectIndex` после анализа кода для сохранения индекса проекта.
2. [`CodeloreService`](/docs/src/service/codelore-service#codeloreservice) вызывает `loadProjectIndex` при старте для загрузки индекса.
3. [`CodeloreService`](/docs/src/service/codelore-service#codeloreservice) вызывает `saveChangeAnalysis` для сохранения результатов анализа изменений и `loadChangeAnalysis` для их загрузки по идентификатору.

## Как менять и что проверять

1. При чтении отсутствующего файла возвращается `undefined`, а не выбрасывается исключение — обеспечивается веткой `if (error instanceof Error && "code" in error && error.code === "ENOENT") { return undefined; }` в `readJson`.
2. При записи гарантируется создание целевой директории — вызывается `await mkdir(dirname(path), { recursive: true })` перед `writeFile` в `writeJson`.
3. `loadProjectIndex` возвращает `undefined` при несовпадении версии — проверяется выражением `loaded.version !== INDEX_VERSION` в `loadProjectIndex`.

## От чего зависит

* `node:fs/promises` (`mkdir`, `readFile`, `writeFile`) — операции с файловой системой.
* `node:path` (`dirname`, `join`) — манипуляции с путями.
* `../types.js` (`ChangeAnalysis`, `CodeloreConfig`, `INDEX_VERSION`, `ProjectIndex`) — типы данных для сериализации.
