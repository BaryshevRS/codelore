# JsonStorage

```ts
class JsonStorage
```

## Зачем это нужно

Сохранение и загрузка индексных данных и результатов анализа изменений в JSON-файлы.

## Что делает

- Сохраняет и загружает три вида данных (индекс проекта, карту доменов, анализ изменений) через приватные методы `writeJson` и `readJson`.
- При записи рекурсивно создаёт целевую директорию через `mkdir(dirname(path), { recursive: true })`.
- При чтении отсутствующего файла возвращает `undefined`; при несовпадении версии — также `undefined` для индекса и карты доменов.
- Предоставляет публичные методы для получения путей к файлам (`indexPath`, `domainMapPath`, `changePath`).

## На что можно положиться

- Отсутствующий файл при чтении всегда даёт `undefined`, а не исключение — `readJson` перехватывает `ENOENT`.
- Запись атомарна относительно директорий: `mkdir` с `recursive: true` гарантирует существование целевой директории перед `writeFile`.
- `loadProjectIndex` возвращает `undefined` при `loaded.version !== INDEX_VERSION`.
- `loadChangeAnalysis` возвращает данные без проверки версии — любое валидное JSON-содержимое файла принимается как `ChangeAnalysis`.
- Все пути детерминированы: `indexPath` и `changePath` вычисляются только из `config.rootDir` и `config.indexDir`.

## Кто и как использует

- [`IndexManager`](../service/index-manager.codelore.md#indexmanager) вызывает `saveProjectIndex` и `loadProjectIndex` для сохранения и восстановления индекса проекта.
- `saveChangeAnalysis` и `loadChangeAnalysis` используются для сохранения и загрузки резултатов анализа изменений.
- `saveDomainMap` и `loadDomainMap` используются для работы с картой доменов.

## Чего не делает

- `loadChangeAnalysis` не проверяет версию данных — любое валидное JSON-содержимое файла принимается как `ChangeAnalysis`, что может привести к загрузке несовместимых данных при изменении схемы.
- `readJson` перехватывает только `ENOENT`; любые другие ошибки чтения (повреждённый файл, проблемы с правами) пробрасываются вызывающему коду как исключение.

## Как менять и что проверять

- При чтении отсутствующего файла возвращается `undefined` — обеспечивается проверкой `error.code === "ENOENT"` в `readJson`.
- При записи гарантируется создание целевой директории — вызывается `await mkdir(dirname(path), { recursive: true })` в `writeJson`.
- `loadProjectIndex` возвращает `undefined` при несовпадении версии — проверяется выражением `loaded.version !== INDEX_VERSION`.
- `loadDomainMap` возвращает `undefined` при несовпадении версии — проверяется выражением `loaded.version !== DOMAIN_MAP_VERSION`.

## От чего зависит

- `node:fs/promises` (`mkdir`, `readFile`, `writeFile`) — файловые операции.
- `node:path` (`dirname`, `join`) — построение путей.
- `../domains/domain-map.js` (`DOMAIN_MAP_VERSION`, `DomainMap`) — тип и версия карты доменов для `saveDomainMap`/`loadDomainMap`.
- `../types.js` (`ChangeAnalysis`, `CodeloreConfig`, `INDEX_VERSION`, `ProjectIndex`) — типы и константы версий для сериализации.
