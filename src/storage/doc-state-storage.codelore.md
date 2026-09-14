# computeConfigFingerprint

```ts
computeConfigFingerprint(config: CodeloreConfig): string
```

## Зачем это нужно

Вычисляет детерминированный отпечаток полей конфигурации, влияющих на рендеринг документации, для обнаружения изменений.

## Что делает

- Сериализует в канонический JSON ровно четыре поля конфигурации — `config.thresholds`, `config.docs.blockHeadings`, `config.docs.translations` и `config.docs.blockHeadingsByLanguage` — через внутреннюю `stableStringify`, которая сортирует ключи объектов и отбрасывает `undefined`.
- Вычисляет SHA-256 от полученной строки через `createHash` из `node:crypto` и возвращает первые 32 символа hex-дайджеста.

## На что можно положиться

- Возвращает строку из 32 шестнадцатеричных символов (SHA-256, обрезанный до 32 символов).
- Детерминирована: внутренняя сериализация сортирует ключи объектов по алфавиту и игнорирует undefined-значения.
- Учитывает только поля thresholds, config.docs.blockHeadings, config.docs.translations и config.docs.blockHeadingsByLanguage; остальные поля конфигурации не влияют на отпечаток.
- Не мутирует переданный объект config.

## От чего зависит

- `createHash` из `node:crypto` — SHA-256 для вычисления отпечатка.
- Внутренняя `stableStringify` — каноническая сериализация объекта (определена в том же файле).

## Кто и как использует

Вызывается в `DocStateStorage.renderAndPersist` для сохранения отпечатка конфигурации в стейт после рендеринга. Вызывается в `DocStateStorage.reapplyConfigToAllDocs` для сравнения текущего отпечатка с сохранёнными и выбора документов, требующих перерендера.

## Чего не делает

- Ограничен четырьмя полями конфигурации: `thresholds`, `blockHeadings`, `translations`, `blockHeadingsByLanguage`. Изменения других полей (например, `sourceGlobs`, `llm`) не обнаруживаются.
- Длина отпечатка ограничена 32 символами за счёт `slice(0, 32)` от хеша SHA-256.

# applyRenderDecision

## Зачем это нужно

Принимает решение о рендеринге каждого блока секции на основе оценок качества и настроечных порогов.

## Что делает

- Не меняет содержимое блоков.
- Для пустых блоков сбрасывает `rendered` в `false` и очищает stale-метаданные.
- Для блоков без оценок сохраняет предыдущее решение.
- Делегирует вычисление порога `effectiveThreshold` и финальной оценки `blockFinalScore`.

## На что можно положиться

- Пустое тело блока всегда даёт `rendered = false` и очищает stale-флаги.
- Отсутствие оценок (`block.scores`) оставляет `rendered` без изменений.
- Для блоков `purpose` и `responsibility` порог по умолчанию равен 0, если нет переопределения в `perBlockScore`.
- Финальная оценка блока — минимум из трёх метрик.

## От чего зависит

Нет внешних зависимостей. Использует внутренние `effectiveThreshold` и `blockFinalScore` (определены в том же файле).

## Кто и как использует

Вызывается в начале `renderAndPersist` перед сохранением стейта и генерацией Markdown.

## Чего не делает

- Не нормализует оценки — полагается на то, что значения `block.scores` уже корректны (должны быть в [0, 1]). Отсутствует проверка допустимости.
- При отсутствии оценок (`block.scores === undefined`) решение не принимается: `continue`. Блок сохраняет предыдущее значение `rendered`.

## Как менять и что проверять

- Изменение `ALWAYS_RENDER_BLOCKS` (текущее значение: `new Set(["purpose", "responsibility"])`) изменит, какие блоки отображаются при отсутствии переопределения в `perBlockScore`.
- Изменение логики `blockFinalScore` (выражение `Math.min(block.scores.informativeness, block.scores.novelty, block.scores.specificity)`) изменит способ вычисления финальной оценки и повлияет на порог отображения.

# DocStateStorage

```ts
class DocStateStorage
```

## Зачем это нужно

Координирует сохранение и управление JSON-состоянием документа, его рендеринг в Markdown-файлы (включая переводы) и очистку устаревших файлов, обеспечивая атомарность записи и целостность файловой структуры.

## Что делает

- Управляет JSON-состояниями документов: загружает файл с проверкой версии, сохраняет и удаляет его по `docPath`, используя `statePathFor`, а список состояний получает обходом JSON-файлов через `listDocStates`.
- Рендерит документ и все языки из `config.docs.translations` через [`renderDoc`](../markdown/render-doc.codelore.md#renderdoc) и записывает Markdown-файлы; при изменении отпечатка конфигурации пересчитывает решения рендеринга и сохраняет состояние, при совпадении — переписывает Markdown-файлы.
- Поддерживает кэш контекста ссылок и `docInfo` для всех состояний, обновляя его при сохранении и удалении; очищает устаревшие файлы переводов.
- При удалении документа целиком убирает JSON-состояние, основной `.md` и все переводы-сироты.

## На что можно положиться

- Отсутствующий файл состояния не является ошибкой: `loadDocState` возвращает `undefined` при `ENOENT`, а `listDocStates` возвращает `[]`, если каталог состояния отсутствует.
- Несовпадение `state.version` с `DOC_STATE_VERSION` выбрасывает ошибку с кодом `UNSUPPORTED_STATE_VERSION`; состояние не загружается.
- Запись JSON и Markdown атомарна: содержимое сначала пишется в `<path>.tmp`, затем `rename` заменяет целевой файл.
- `cleanupTranslationFiles` удаляет только файлы, соответствующие `<base>.<lang><suffix>`, не входящие в `keep` и не имеющие собственного JSON-состояния; кандидат с собственным state-файлом остаётся.
- При сверке документов с состоянием обновляются только те, чей сохранённый `configFingerprint` отличается от текущего; при совпадении JSON-состояние не меняется, а `.md` переписывается только при отличии содержимого.
- Кэш `renderContextPromise` создаётся один раз и обновляется при `saveDocState`/`deleteDocState`, которые добавляют или удаляют ссылки и `docInfo`.

## От чего зависит

Использует [`CodeloreError`](../errors.codelore.md#codeloreerror) из `src/errors.ts` для выбрасывания ошибки при несовпадении версии состояния. Рендер Markdown делегирует [`renderDoc`](../markdown/render-doc.codelore.md#renderdoc) из `src/markdown/render-doc.ts`. Для управления картой ссылок и docInfo вызывает [`buildEntityLinkMap`](../markdown/linkify.codelore.md#buildentitylinkmap), [`addDocToLinkMap`](../markdown/linkify.codelore.md#adddoctolinkmap), [`removeDocFromLinkMap`](../markdown/linkify.codelore.md#removedocfromlinkmap) из `src/markdown/linkify.ts`. Путь к файлу перевода вычисляет через [`translationDocPath`](../markdown/doc-paths.codelore.md#translationdocpath) из `src/markdown/doc-paths.ts`. Остальные зависимости — внутренние функции этого же файла: [`applyRenderDecision`](#applyrenderdecision), [`computeConfigFingerprint`](#computeconfigfingerprint), `splitDocPath`, `escapeRegExp`, `stripMarkdownExtension`, `collectJsonFiles`, `docInfoOf`, а также модули `node:fs`, `node:fs/promises`, `node:path`, `node:crypto`.

## Кто и как использует

[`buildDocIndex`](../indexer/state-indexer.codelore.md#builddocindex) и [`patchDocIndexPaths`](../indexer/state-indexer.codelore.md#patchdocindexpaths) (оба в `src/indexer/state-indexer.ts`) вызывают `loadDocState` для загрузки существующего состояния документа при построении или обновлении индекса. [`applyRewritesToDoc`](../service/section-rewrite.codelore.md#applyrewritestodoc) (`src/service/section-rewrite.ts`) вызывает `renderAndPersist` после применения правок к секциям. [`IndexManager`](../service/index-manager.codelore.md#indexmanager) (`src/service/index-manager.ts`) использует различные методы класса для управления состояниями документов. `reconcileRenderedDocs` вызывается при сверке всех документов: для каждого состояния проверяет отпечаток конфигурации и либо пересохраняет состояние с перерендером, либо переписывает только Markdown-файлы при отличии содержимого.

## Чего не делает

- [`computeConfigFingerprint`](#computeconfigfingerprint) покрывает только поля `thresholds`, `blockHeadings`, `translations`, `blockHeadingsByLanguage` — изменения других полей конфигурации не вызывают перерендер.
- `listDocStates` рекурсивно обходит все JSON-файлы в каталоге `state` без ограничения глубины, исключая только файлы с `.generation-debug.` в имени.
- `loadDocState` выбрасывает исключение при непарсибельном JSON, не пытаясь восстановить данные.

## Как менять и что проверять

- Атомарность записи: `saveDocState` и `writeDocFile` сначала пишут содержимое во временный файл с суффиксом `.tmp`, затем выполняют `rename`. Конструкция: `const tmpPath = \`${absolutePath}.tmp\`; await writeFile(tmpPath, ...); await rename(tmpPath, absolutePath);`.
- Версионирование состояния: `loadDocState` выбрасывает [`CodeloreError`](../errors.codelore.md#codeloreerror) с кодом `UNSUPPORTED_STATE_VERSION` при несовпадении `state.version` с `DOC_STATE_VERSION`. Конструкция: `if (state.version !== DOC_STATE_VERSION) { throw new CodeloreError("UNSUPPORTED_STATE_VERSION", ...); }`.
- Очистка переводов-сирот: `cleanupTranslationFiles` удаляет только файлы, соответствующие шаблону `<base>.<lang><suffix>`, не входящие в `keep` и не имеющие собственного JSON-состояния. Конструкция: `if (existsSync(this.statePathFor(candidateDocPath))) { continue; }`.
- Кэш контекста рендера: `renderContextPromise` создаётся один раз через `buildRenderContext` и обновляется при `saveDocState`/`deleteDocState`. Конструкция: `this.renderContextPromise ??= this.buildRenderContext();`.
