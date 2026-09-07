# stripComments

## Зачем это нужно

Очистка исходного кода от комментариев для передачи в LLM и верификацию.

## Что делает

- Не заменяет лексер — использует `ts.createScanner` для токенизации.
- Не обрабатывает JSX (выбран `LanguageVariant.Standard`).
- Разрешает неоднозначность деления и регулярного выражения через контекст предыдущего значимого токена.
- Нормализует пробелы: удаляет концевые пробелы строк и схлопывает три и более перевода строки в два.

## На что можно положиться

- Никогда не бросает исключений — при любой строке возвращает новую строку.
- Все одно- и многострочные комментарии удалены.
- Нормализация пробелов сохраняет логическую структуру (количество строк может уменьшиться из-за схлопывания).

## От чего зависит

- `typescript` — предоставляет лексер (`ts.createScanner`) для разбиения на токены и определения типа комментария.

## Кто и как использует

- [`planWriterChunks`](file-chunks.codelore.md#planwriterchunks) (src/llm/file-chunks.ts): обрезает комментарии из каждого файла источника перед сборкой в чанки. Если весь файл влезает в лимит символов, применяет `stripComments` ко всему файлу сразу.
- `buildVerifySections` ([src/llm/file-pipeline.ts](file-pipeline.codelore.md)): обрабатывает срез исходного кода сущности (от `startOffset` до `endOffset`) перед передачей в верификатор.
- `verifyBlocksAgainstDeps` ([src/llm/file-pipeline.ts](file-pipeline.codelore.md)): аналогично `buildVerifySections`, обрабатывает срезы для верификации блоков документации.
- [`collectTypeContext`](type-context.codelore.md#collecttypecontext) (src/llm/type-context.ts): очищает извлечённые объявления типов от комментариев для отправки в контекст LLM.

## Чего не делает

- Не обрабатывает JSX — при `LanguageVariant.Standard` токены JSX могут быть лексемизированы некорректно.
- Может ошибочно интерпретировать косую черту как начало регулярного выражения, если предыдущий значимый токен отсутствует в `DIVISION_CONTEXT_TOKENS` (например, макрос или нестандартный синтаксис).
- Удаление комментариев уничтожает аннотации вроде `@ts-expect-error` или `// eslint-disable-next-line`, которые могут влиять на поведение downstream.
- Схлопывание переводов строк может изменить относительные номера строк, что критично для `buildVerifySections` и `verifyBlocksAgainstDeps`, режущих по офсетам.

## Как менять и что проверять

- Изменение набора `DIVISION_CONTEXT_TOKENS` — инвариант, закреплённый в строгом перечислении токенов (`ts.SyntaxKind.Identifier` … `ts.SyntaxKind.MinusMinusToken`), проверять в [`planWriterChunks`](file-chunks.codelore.md#planwriterchunks), [`collectTypeContext`](type-context.codelore.md#collecttypecontext) и обоих вызовах из `file-pipeline.ts`.
