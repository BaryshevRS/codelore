# translationDocPath

```ts
translationDocPath(docPath: string, language: string): string
```

## Зачем это нужно

Строит путь файла перевода для документа, вставляя код языка в имя файла так, чтобы перевод сохранялся рядом с оригиналом и имел предсказуемое имя.

## Что делает

Проверяет, оканчивается ли путь на `.codelore.md`; если да, заменяет суффикс на `.${language}.codelore.md`. Иначе проверяет окончание `.md` и заменяет его на `.${language}.md`. Если ни одно из окончаний не совпало, добавляет `.${language}` в конец пути. Возвращает полученную строку.

## На что можно положиться

Для пути, оканчивающегося на `.codelore.md`, возвращает путь с языком, вставленным перед суффиксом: `doc.codelore.md` → `doc.ru.codelore.md`. Для пути, оканчивающегося на `.md`, возвращает путь с языком перед `.md`: `doc.md` → `doc.ru.md`. Для любого другого пути возвращает путь с языком, добавленным в конец: `doc` → `doc.ru`. Функция всегда возвращает строку с языком, независимо от исходного формата пути.

## Чего не делает

The function only handles paths ending in `.codelore.md` or `.md`; for any other path it appends the language at the end, as enforced by the two `endsWith` checks and the final fallback return.

## Как менять и что проверять

- The suffix check uses `docPath.endsWith(CODELORE_MD_SUFFIX)` to decide the `.codelore.md` branch, and `docPath.endsWith(".md")` for the generic `.md` branch — both are literal in the source.
- The fallback branch appends the language with `${docPath}.${language}` when neither suffix matches, as written in the source.
