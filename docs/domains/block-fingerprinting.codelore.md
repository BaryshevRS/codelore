# Отпечатки блоков документации

## Состав

- [member-evidence](../../src/domains/member-evidence.codelore.md#member-evidencets) — The file exists to compute a stable fingerprint of a domain member's evidence, so that the doc's dependency facet and skeleton can be updated only when the member's membership or cross-domain edges change, avoiding unnecessary re-renders.
- [block-facets](../../src/markdown/block-facets.codelore.md) — Определяет, изменилось ли содержимое блока документации, путём вычисления хеша по релевантным фасетам сущностей.

**Зависит от:** [Общие низкоуровневые утилиты](common-utils.codelore.md#общие-низкоуровневые-утилиты)
**Используется в:** [Фасад сервиса Codelore](codelore-service-facade.codelore.md#фасад-сервиса-codelore) · [Согласование и валидация состояния документации](doc-state-consistency.codelore.md#согласование-и-валидация-состояния-документации) · [Рендеринг и локализация Markdown-документов](markdown-rendering.codelore.md#рендеринг-и-локализация-markdown-документов) · [Применение перезаписей секций](section-rewrite-application.codelore.md#применение-перезаписей-секций) · [Обнаружение устаревших блоков документации](stale-blocks-detection.codelore.md#обнаружение-устаревших-блоков-документации)

> ⚠ Устарело (memberDocs_changed, с 2026-09-14T12:57:23.995Z): Зачем это нужно, Что делает, От чего зависит, Кто и как использует, Чего не делает. Обновите документацию.
