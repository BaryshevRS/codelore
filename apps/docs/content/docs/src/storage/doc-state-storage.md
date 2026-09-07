---
title: computeConfigFingerprint
---

## Зачем это нужно

Вычисляет детерминированный отпечаток полей конфигурации, влияющих на рендеринг документации, для обнаружения изменений.

## Что делает

* Учитывает только `thresholds` и `blockHeadings`. Не затрагивает `sourceGlobs`, `llm`, `testGlobs` и другие поля.
* Делегирует хеширование в `createHash` из `node:crypto`, каноническую сериализацию — во внутреннюю `stableStringify`.

## На что можно положиться

* Возвращает строку из 32 шестнадцатеричных символов (SHA-256, обрезанный до 32 символов).
* Детерминирована: внутренняя сериализация сортирует ключи объектов по алфавиту и игнорирует undefined-значения.
* Учитывает только поля thresholds, config.docs.blockHeadings, config.docs.translations и config.docs.blockHeadingsByLanguage; остальные поля конфигурации не влияют на отпечаток.
* Не мутирует переданный объект config.

## От чего зависит

* `createHash` из `node:crypto` — SHA-256 для вычисления отпечатка.
* Внутренняя `stableStringify` — каноническая сериализация объекта (определена в том же файле).

## Кто и как использует

Вызывается в `DocStateStorage.renderAndPersist` для сохранения отпечатка конфигурации в стейт после рендеринга. Вызывается в `DocStateStorage.reapplyConfigToAllDocs` для сравнения текущего отпечатка с сохранёнными и выбора документов, требующих перерендера.

## Чего не делает

* Ограничен четырьмя полями конфигурации: `thresholds`, `blockHeadings`, `translations`, `blockHeadingsByLanguage`. Изменения других полей (например, `sourceGlobs`, `llm`) не обнаруживаются.
* Длина отпечатка ограничена 32 символами за счёт `slice(0, 32)` от хеша SHA-256.

## applyRenderDecision

### Зачем это нужно

Принимает решение о рендеринге каждого блока секции на основе оценок качества и настроечных порогов.

### Что делает

* Не меняет содержимое блоков.
* Для пустых блоков сбрасывает `rendered` в `false` и очищает stale-метаданные.
* Для блоков без оценок сохраняет предыдущее решение.
* Делегирует вычисление порога `effectiveThreshold` и финальной оценки `blockFinalScore`.

### На что можно положиться

* Пустое тело блока всегда даёт `rendered = false` и очищает stale-флаги.
* Отсутствие оценок (`block.scores`) оставляет `rendered` без изменений.
* Для блоков `purpose` и `responsibility` порог по умолчанию равен 0, если нет переопределения в `perBlockScore`.
* Финальная оценка блока — минимум из трёх метрик.

### От чего зависит

Нет внешних зависимостей. Использует внутренние `effectiveThreshold` и `blockFinalScore` (определены в том же файле).

### Кто и как использует

Вызывается в начале `renderAndPersist` перед сохранением стейта и генерацией Markdown.

### Чего не делает

* Не нормализует оценки — полагается на то, что значения `block.scores` уже корректны (должны быть в \[0, 1]). Отсутствует проверка допустимости.
* При отсутствии оценок (`block.scores === undefined`) решение не принимается: `continue`. Блок сохраняет предыдущее значение `rendered`.

### Как менять и что проверять

* Изменение `ALWAYS_RENDER_BLOCKS` (текущее значение: `new Set(["purpose", "responsibility"])`) изменит, какие блоки отображаются при отсутствии переопределения в `perBlockScore`.
* Изменение логики `blockFinalScore` (выражение `Math.min(block.scores.informativeness, block.scores.novelty, block.scores.specificity)`) изменит способ вычисления финальной оценки и повлияет на порог отображения.

## DocStateStorage

### Зачем это нужно

Координирует сохранение и управление JSON-состоянием документа, его рендеринг в Markdown-файлы (включая переводы) и очистку устаревших файлов, обеспечивая атомарность записи и целостность файловой структуры.

### Что делает

* Сохраняет JSON-состояние в поддиректории <indexDir>/state/ и рендерит Markdown-файл документа через [`renderDoc`](/docs/src/markdown/render-doc#renderdoc), всегда используя атомарную запись: сначала во временный файл, затем `rename`.\n- Управляет файлами переводов: генерирует `*.language.codelore.md` для каждого языка из `config.docs.translations`, а также удаляет файлы переводов, у которых нет собственного состояния, через `cleanupTranslationFiles`.\n- Предоставляет метод `reapplyConfigToAllDocs`, который перебирает все состояния, сравнивает отпечаток конфигурации через [`computeConfigFingerprint`](#computeconfigfingerprint) и перерендеривает только документы с изменившимся отпечатком.

### На что можно положиться

* `deleteDoc` удаляет и JSON-состояние, и основной Markdown-файл, и все файлы переводов, у которых нет собственного файла состояния.
* `loadDocState` повышает версию до актуальной, если загруженный state версии меньше, не производя миграции данных.
* `renderAndPersist` всегда вычисляет и обновляет `configFingerprint` в сохраняемом состоянии.
* `cleanupTranslationFiles` удаляет только те файлы переводов, которые не имеют собственного JSON-состояния и не входят в множество `keep`.

### От чего зависит

Использует внешние модули: `existsSync` из `node:fs`, `mkdir`, `readdir`, `readFile`, `rename`, `rm`, `writeFile` из `node:fs/promises`, `basename`, `dirname`, `join`, `relative`, `sep` из `node:path`. Также полагается на внутренние функции этого же файла: [`applyRenderDecision`](#applyrenderdecision), [`computeConfigFingerprint`](#computeconfigfingerprint), [`translationDocPath`](#translationdocpath), `splitDocPath`, `stableStringify`, `escapeRegExp`, `stripMarkdownExtension`, `collectJsonFiles`. Рендер Markdown делегируется [`renderDoc`](/docs/src/markdown/render-doc#renderdoc) из `src/markdown/render-doc.ts`.

### Кто и как использует

`loadDocState` вызывается из [`buildDocIndex`](/docs/src/indexer/state-indexer#builddocindex) и [`patchDocIndexPaths`](/docs/src/indexer/state-indexer#patchdocindexpaths) (оба в `src/indexer/state-indexer.ts`) для загрузки существующего состояния документа при построении или обновлении индекса. `renderAndPersist` вызывается из `reapplyConfigToAllDocs` при массовом перерендере после изменения конфигурации и из [`applyRewritesToDoc`](/docs/src/service/section-rewrite#applyrewritestodoc) (`src/service/section-rewrite.ts`) после применения правок к секциям. [`IndexManager`](/docs/src/service/index-manager#indexmanager) (`src/service/index-manager.ts`) использует различные методы класса для управления состояниями документов.

### Чего не делает

* Нет кэширования стейтов: каждый вызов `loadDocState` читает JSON-файл с диска.
* Файлы стейтов не сжаты: `JSON.stringify` без сжатия.
* Отпечаток конфигурации ([`computeConfigFingerprint`](#computeconfigfingerprint)) покрывает только поля `thresholds`, `blockHeadings`, `translations`, `blockHeadingsByLanguage`; изменения других полей конфигурации не вызывают перерендер.
* `listDocStates` рекурсивно обходит все JSON-файлы в каталоге `state` без ограничения глубины, включая файлы, не являющиеся стейтами (исключаются только файлы с `.generation-debug.` в имени).
* `saveDocState` и `writeDocFile` не содержат блокировки или повтора при сбое `rename`.
* `loadDocState` выбрасывает исключение при непарсибельном JSON, не пытаясь восстановить данные.

### Как менять и что проверять

* Атомарность записи: методы `saveDocState` и `writeDocFile` сначала записывают содержимое во временный файл с суффиксом `.tmp`, затем выполняют `rename`. Конструкции: `const tmpPath = \`${absolutePath}.tmp\`; await writeFile(tmpPath, ...); await rename(tmpPath, absolutePath);\` в обоих методах. Тесты: нет.
* Версионирование стейта: `loadDocState` повышает версию загруженного состояния до `DOC_STATE_VERSION` (текущее значение 4), если она меньше. Конструкция: `if (state.version < DOC_STATE_VERSION) { state.version = DOC_STATE_VERSION; }`. Тесты: нет.

## translationDocPath

### Зачем это нужно

Вычисляет путь к переведённому файлу документации на основе исходного пути и кода языка.

### Что делает

* Определяет шаблон вставки кода языка в зависимости от суффикса docPath.
* Не читает и не записывает файлы, не валидирует код языка.

### На что можно положиться

* Результат детерминирован: при одинаковых docPath и language возвращается один и тот же путь.
* Функция не выбрасывает исключений — в теле нет доступа к файловой системе или ассертов.

### От чего зависит

Не использует внешних модулей; опирается на константу `CODELORE_MD_SUFFIX`, определённую в том же файле.

### Кто и как использует

Вызывается в `DocStateStorage.renderAndPersist` для каждого языка из `config.docs.translations`. Сформированный путь передаётся для записи отрендеренного Markdown-перевода на диск.

### Как менять и что проверять

* Инвариант: при суффиксе `.codelore.md` язык вставляется между базовым именем и суффиксом. Обеспечивается конструкцией `docPath.endsWith(CODELORE_MD_SUFFIX)` и `docPath.slice(0, -CODELORE_MD_SUFFIX.length)`. Тесты: нет.
* Инвариант: при суффиксе `.md` (но не `.codelore.md`) язык вставляется через точку перед `.md`. Обеспечивается конструкцией `docPath.endsWith('.md')`. Тесты: нет.
