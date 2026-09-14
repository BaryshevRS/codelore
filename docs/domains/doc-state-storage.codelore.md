# Хранилище состояния документации

## Состав

- [doc-state-storage](../../src/storage/doc-state-storage.codelore.md) — Вычисляет детерминированный отпечаток полей конфигурации, влияющих на рендеринг документации, для обнаружения изменений.

**Зависит от:** [Перевод документации](doc-translation.codelore.md#перевод-документации) · [Единый формат ошибок](error-handling.codelore.md#единый-формат-ошибок) · [Рендеринг и локализация Markdown-документов](markdown-rendering.codelore.md#рендеринг-и-локализация-markdown-документов)
**Используется в:** [Индексация кода и документации](code-doc-indexing.codelore.md#индексация-кода-и-документации) · [Фасад сервиса Codelore](codelore-service-facade.codelore.md#фасад-сервиса-codelore) · [Управление индексом проекта](project-index-manager.codelore.md#управление-индексом-проекта) · [Применение перезаписей секций](section-rewrite-application.codelore.md#применение-перезаписей-секций)
