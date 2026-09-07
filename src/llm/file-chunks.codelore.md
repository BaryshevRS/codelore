# planWriterChunks

## Зачем это нужно

Разбивает набор исходных файлов и секций документации на чанки, каждый из которых помещается в контекст одной LLM-генерации с учётом лимитов токенов и числа секций, заданных через WriterBudget.

## Что делает

- Проверяет, укладывается ли общий объём исходников и число секций в лимиты; при выполнении обоих условий возвращает единственный чанк со всеми файлами (с удалёнными комментариями) и секциями.
- Если лимиты превышены, разбивает файлы по границам top-level сущностей, а затем распределяет секции по полученным драфтам.
- Драфты, которым не назначена ни одна секция, не порождают чанков - их код не передаётся в LLM.
- Каждый драфт с секциями дополнительно дробится по maxSectionsPerChunk; итоговые чанки нумеруются последовательно.

## На что можно положиться

- Если общий объём и число секций укладываются в лимиты, возвращается ровно один чанк (проверка if (total <= maxSourceChars && input.sections.length <= maxSections)).
- Каждый чанк содержит не более budget.maxSectionsPerChunk секций (цикл for (let start = 0; start < draftSections.length; start += maxSections)).
- Класс и все его методы всегда находятся в одном чанке: разрез файла производится только по top-level границам.
- Драфт без назначенных секций не порождает чанков: пустой массив draftSections приводит к нулевым итерациям цикла.
- Число итоговых чанков равно числу элементов в массиве pieces, каждый с уникальным номером part от 1 до parts.

## От чего зависит

- [`stripComments`](strip-comments.codelore.md#stripcomments) (`src/llm/strip-comments.ts`) — очищает исходный код от комментариев для уменьшения объёма, передаваемого в LLM.

## Кто и как использует

Вызывается из [`generateFileGroup`](file-pipeline.codelore.md#generatefilegroup) (`src/llm/file-pipeline.ts`) после того, как та собрала исходные файлы и секции документации. [`generateFileGroup`](file-pipeline.codelore.md#generatefilegroup) передаёт в `planWriterChunks` массив `sources` (содержимое файлов, прочитанное через `readFile`), массив `sections` (сформированных через `fileWriteSection`), `code` из `index.code`, `budget` из `provider.writerBudget` и `overheadChars`. Результат — массив `WriterChunk[]` — [`generateFileGroup`](file-pipeline.codelore.md#generatefilegroup) передаёт в `generateChunk` для каждого чанка, параллельно через `pLimit`.

## Чего не делает

- При разбиении файла содержимое заголовка (до первой top-level сущности) дублируется во все результирующие чанки из-за передачи `header` в `draftFromSegments` в функции `splitFile`.
- Если файл не содержит top-level сущностей, `topLevelStarts` возвращает пустой массив, и `splitFile` возвращает единственный чанк через `wholeFileDraft`, который может превысить `maxSourceChars`.
- Упаковка сегментов в чанки использует жадный алгоритм (цикл в `splitFile` с `flush()`), который не минимизирует число чанков.

## Как менять и что проверять

1. Изменение константы `maxSourceChars` (вычисляется как `Math.max(0, input.budget.maxPromptTokens * input.budget.charsPerToken - input.overheadChars)`) может нарушить предположения `generateChunk` о размере контекста — проверить тесты в `file-chunks.test.ts`.
