# renderDoc

```ts
renderDoc(state: DocState, config: CodeloreConfig, language?: string, links?: EntityLinkMap, docInfo?: DocInfoMap): string
```

## Зачем это нужно

Собирает итоговый Markdown-документ из отрендеренных секций, формируя для каждой контекст ссылок и навигационную строку для доменных секций, а при пустом списке секций возвращает пустую строку.

## Что делает

- При пустом `state.sectionOrder` немедленно возвращает `""`, не вычисляя контекст ссылок и не вызывая [`renderSection`](#rendersection).
- Для каждой секции из `state.sectionOrder` строит `linkContext` с целями символов и путей, если переданы `links`; для доменных и проектных секций (определяемых с помощю `isTierSection`) дополнительно формирует навигационную строку `tierLead`.
- Делегирует рендер каждой секции функии [`renderSection`](#rendersection), передавая ей `linkContext` и `tierLead`.
- Склеивает резултаты рендера двойным переводом строки и добавляет завершающий `\n`.

## На что можно положиться

- При пустом `state.sectionOrder` возвращает `""` без завершающего `\n`.
- Порядок секций в итоговом документе соответствует порядку идентификаторов в `state.sectionOrder`.
- Секции разделяются ровно двумя переводами строки, документ завершается одним `\n`.
- Функция не изменяет переданные объекты `state` и `config`.

## От чего зависит

Зависит от [`renderSection`](#rendersection) (тот же файл) для рендера каждой секции; от [`localeBundle`](locales.codelore.md#localebundle) для получения навигационных меток; от [`buildPathTargets`](linkify.codelore.md#buildpathtargets), [`sectionLinkTargets`](linkify.codelore.md#sectionlinktargets), [`buildDomainComposition`](linkify.codelore.md#builddomaincomposition), [`buildDomainRelations`](linkify.codelore.md#builddomainrelations) для построения контекста ссылок и навигационной строки доменных секций; от [`translationDocPath`](doc-paths.codelore.md#translationdocpath) для определения пути переводного документа; от внутренних хелперов `isTranslationLanguage` и `isTierSection`.

## Кто и как использует

Вызывается из `DocStateStorage.reconcileRenderedDocs` и `DocStateStorage.renderAndPersist` для формирования итогового Markdown-документа. При пустом `state.sectionOrder` сразу возвращает `""`. Иначе определяет `translationLanguage` (если язык перевода), строит `pathTargets` и `navLabels`, затем для каждой секции из `state.sectionOrder`: если секция отсутствует — пропускает; строит `linkContext` (если переданы `links`); для доменных/проектных секций формирует `tierLead` из [`buildDomainComposition`](linkify.codelore.md#builddomaincomposition) и [`buildDomainRelations`](linkify.codelore.md#builddomainrelations); вызывает [`renderSection`](#rendersection) с этими параметрами. Результаты склеивает двойным переводом строки и добавляет завершающий `\n`.

## Чего не делает

- При `state.sectionOrder.length === 0` возвращается `""` без завершающего `\n` — конструкция `return "";`.
- Секция, отсутствующая в `state.sections`, молча пропускается (`if (!section) { continue; }`).
- Дубликаты идентификаторов в `state.sectionOrder` приводят к повторному рендеру одной и той же секции, без дедупликации.

## Как менять и что проверять

- Пустой `sectionOrder` возвращает пустую строку без завершающего `\n`. Конструкция: `if (state.sectionOrder.length === 0) { return ""; }`.
- Секции разделяются двумя переводами строки, документ завершается одним `\n`. Конструкция: `` return `${parts.join("\n\n")}\n`; ``.

# renderSection

```ts
renderSection(section: DocStateSection, config: CodeloreConfig, language?: string, linkContext?: BlockLinkContext, navLine?: string): string
```

## Зачем это нужно

Превращает состояние одной секции документа в Markdown-подраздел, управляя заголовками, группировкой устаревших блоков в сводный callout и локализацией заголовков для переводных языков.

## Что делает

- Определяет язык перевода через `isTranslationLanguage` и выбирает заголовки блоков: локализованные из `config.docs.blockHeadingsByLanguage`, если переводной язык, иначе канонические из `config.docs.blockHeadings`.
- Формирует заголовок секции с уровнем вложенности `section.depth` и опционально добавляет сигнатуру и навигационную строку `navLine`.
- Для каждого блока из `orderedRenderableBlocks` проверяет наличие и флаг `rendered`: пропускает отсутствующие и неотрендеренные блоки.
- Блоки с `staleSince` группирует в `Map` по ключу `staleReason + staleSince` и выводит перед свежими блоками одним [`staleCalloutText`](callouts.codelore.md#stalecallouttext) на группу.
- Для свежих блоков выводит подзаголовок и тело, полученное через `blockBody`; если перевод отсутствует или устарел, `blockBody` вставляет `translationPendingCallout` вместо тела.

## На что можно положиться

- Результат всегда начинается с заголовка секции, даже если ни один блок не выведен.
- Stale-блоки выводятся до свежих, сгруппированные по одинаковым `staleReason` и `staleSince`, одним callout на группу.
- Блоки с `rendered: false` или отсутствующие в `section.blocks` не выводятся и не влияют на порядок остальных.
- Порядок свежих блоков: сначала идентификаторы из `section.blockOrder`, затем оставшиеся из `BLOCK_IDS`, оба списка фильтруются по `section.allowedBlocks`.
- Функция не изменяет переданные `section` и `config`.

## От чего зависит

- Uses `BLOCK_IDS` from `block-ids.js` as the fallback order for blocks not explicitly listed in `section.blockOrder`.
- Delegates to [`staleCalloutText`](callouts.codelore.md#stalecallouttext) from `callouts.ts` to produce the summary banner text for stale blocks.
- Delegates to [`linkifyBlockBody`](linkify.codelore.md#linkifyblockbody) from `linkify.ts` to process links in the block body.
- Uses `isTranslationLanguage` and `orderedRenderableBlocks` from the same file to determine the rendering language and the block order.
- Uses `blockBody` from the same file to obtain the rendered body of a fresh block.

## Кто и как использует

1. [`renderDoc`](#renderdoc) iterates over `state.sectionOrder` and calls `renderSection` for each section that exists in `state.sections`.
2. The function receives the section, config, language, link context, and tier lead from the caller, and returns the rendered Markdown string.
3. The caller joins the rendered sections with double newlines and appends a trailing newline to produce the final document.

## Чего не делает

- Blocks that are missing from `section.blocks` or have `rendered` falsy are silently skipped (the `!block?.rendered` check), so they do not appear in the output and do not affect the order of other blocks.
- Stale blocks are never rendered as empty headings; they are collapsed into a per-reason summary banner below the section heading, as enforced by the `if (block.staleSince)` branch.
- The function does not handle the case where `section` is undefined; the caller [`renderDoc`](#renderdoc) checks `if (!section) continue` before calling this function.

## Как менять и что проверять

- The function enforces a deterministic block order by combining `section.blockOrder` with `BLOCK_IDS`, both filtered by `section.allowedBlocks`.
- The function enforces that stale blocks are collapsed into a summary banner instead of being rendered as empty headings, using the `block.staleSince` check and the [`staleCalloutText`](callouts.codelore.md#stalecallouttext) call.
