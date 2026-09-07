---
title: reconcileDocStateWithCode
---

## Зачем это нужно

Синхронизирует `DocState` с текущим набором сущностей кода: удаляет секции, чья сущность исчезла, и обрезает блоки, не разрешённые для сущности.

## Что делает

* Удаляет из `state.sections` и `state.sectionOrder` секции, чья сущность-владелец отсутствует в `entities`.
* Вызывает `pruneDisallowedBlocks` для каждой оставшейся секции, чтобы удалить блоки, не входящие в `owner.metadata.allowedBlocks`.
* Возвращает `true`, если хотя бы одна секция или блок были удалены.

## На что можно положиться

* Не изменяет `state`, если все секции имеют живую сущность и все блоки разрешены.
* При удалении секции также удаляет её идентификатор из `state.sectionOrder`.
* Не бросает исключений при отсутствии сущности или разрешённых блоков.

## Кто и как использует

Вызывается из `CodeloreService.reconcileScopedDocStates` ([`src/service/codelore-service.ts`](/docs/src/service/codelore-service)) для каждого `docPath`, чьи секции попадают под переданный `scope`. Если `reconcileDocStateWithCode` вернул `true`, вызывающий либо удаляет документ (при пустом `state.sectionOrder`), либо перезаписывает его, а затем перестраивает индексы без рендера документов.

## Как менять и что проверять

* При удалении секции её идентификатор удаляется из `state.sectionOrder` через `state.sectionOrder.filter((id) => id !== sectionId)`. Тест: `reconcileDocStateWithCode` (предположительно в `doc-reconcile.test.ts`).
* При удалении блока его идентификатор удаляется из `section.blockOrder` и `section.allowedBlocks` через `section.blockOrder.filter((id) => allowedSet.has(id))` и `section.allowedBlocks.filter((id) => allowedSet.has(id))`. Тест: `pruneDisallowedBlocks` (предположительно в `doc-reconcile.test.ts`).
