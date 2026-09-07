---
title: computeEntityMetrics
---

## Зачем это нужно

Точка входа для расчёта метрик всех сущностей код-индекса.

## Что делает

* Не вычисляет метрики напрямую — делегирует [`countStatements`](#countstatements), [`effectiveDirectUsages`](#effectivedirectusages), [`hasSideEffects`](#hassideeffects).
* Не модифицирует переданные `records` или `entities`.
* Не определяет, какие блоки документации включать — это задача `determineBlockInclusion`.

## На что можно положиться

* Возвращает `Map` с ровно одной записью на каждый элемент `records`.
* Поля `statementCount`, `inDegree`, [`hasSideEffects`](#hassideeffects), `isEntryPoint` вычисляются детерминированно.
* Порядок записей в `Map` не гарантирован.

## От чего зависит

Вызывает функции: countStatements, effectiveDirectUsages, hasSideEffects — все из того же файла. Использует аргументы records, entities, config.

## Кто и как использует

Вызывается из buildCodeIndex ([src/indexer/code-indexer.ts](/docs/src/indexer/code-indexer)) при построении CodeIndex. Возвращаемый Map используется в populateDocumentationMetadata для наполнения метаданных каждой сущности.

## Чего не делает

Не обрабатывает динамические импорты и рефлексию — статический анализ ts-morph ограничен синтаксическим деревом. Не проверяет корректность переданных records или entities.

## Как менять и что проверять

* Каждый элемент records даёт ровно одну запись в возвращаемом Map — это обеспечивается циклом `for (const record of records) { metrics.set(record.entity.id, …) }`.
* inDegree вычисляется как длина массива, возвращённого effectiveDirectUsages — это зафиксировано выражением `inDegree: effectiveDirectUsages(record.entity, entities).length`.

## effectiveDirectUsages

### Зачем это нужно

Фильтрация списка прямых использований сущности для расчёта in-degree.

### Что делает

* Не модифицирует `entity.directUsages`.
* Не проверяет, что переданные `entities` содержат все id из `directUsages`.
* Не учитывает транзитивные использования.

### На что можно положиться

* Возвращает только те id, которые присутствуют в `entities`.
* Всегда исключает id файла сущности и id класса-владельца (для методов).
* Не возвращает дубликаты — исходный массив может содержать дубли, но фильтр их не удаляет.

### От чего зависит

Фильтрация зависит от функции owningClassEntityId.

### Кто и как использует

Вызывается из computeEntityMetrics для вычисления inDegree (как .length возвращаемого массива). Также вызывается из decision-pass.ts и wrapper-detector.ts для проверки единственности использования в логике поглощения.

### Чего не делает

Полагается на корректность поля directUsages — ошибки в индексе не выявляются. Не проверяет, что directUsages не содержит дубликатов.

## countStatements

### Зачем это нужно

Подсчёт количества операторов в узле AST для оценки размера сущности.

### Что делает

* Не различает типы операторов — считает все, перечисленные в `isStatementSignal`.
* Не считает операторы вложенных функций отдельно — использует `getDescendants`.
* Для класса суммирует операторы всех методов.

### На что можно положиться

* Возвращает `number ≥ 0`.
* Для `SourceFile` считает только корневые операторы (не рекурсивно в функции).
* Для `ClassDeclaration` рекурсивно считает операторы методов.

### От чего зависит

Использует isStatementSignal для определения, что считать оператором.

### Кто и как использует

Вызывается из computeEntityMetrics для statementCount и из wrapper-detector.ts при детекции обёрток (recordPublicWrapper, isAnchorPrivate).

### Чего не делает

Не различает пустые операторы (например, точка с запятой может быть учтена как ExpressionStatement). Не учитывает комментарии и пробелы.

### Как менять и что проверять

* Для SourceFile операторы считаются рекурсивно: каждый корневой оператор, не являющийся сигналом (например, класс или функция), обрабатывается рекурсивно для подсчёта вложенных операторов — это обеспечивается условием `if (Node.isSourceFile(node)) { return node.getStatements().reduce(…) }`.
* Для ClassDeclaration суммируются операторы всех методов — это обеспечивается условием `if (Node.isClassDeclaration(node)) { return node.getMethods().reduce(…) }`.

## hasSideEffects

### Зачем это нужно

Статическое определение наличия побочных эффектов в узле AST.

### Что делает

* Не выполняет код — только статический анализ.
* Не проверяет динамические вызовы (через `eval`, `new Function`).
* Не учитывает побочные эффекты через присваивания свойств объектов (кроме `process.env`).

### На что можно положиться

* Возвращает `true`, если обнаружен вызов из `DEFAULT_SIDE_EFFECT_CALLS` или импорт из `DEFAULT_SIDE_EFFECT_MODULES`.
* Возвращает `true` при присваивании `process.env.*`.
* Учитывает дополнительные паттерны из `config.sideEffectPatterns`.

### От чего зависит

Полагается на sideEffectImportNames для детекции импортов.

### Кто и как использует

Вызывается из computeEntityMetrics для заполнения поля hasSideEffects.

### Чего не делает

Ложные отрицания для вызовов через переменные (const fn = fetch; fn()). Не обнаруживает побочные эффекты через Proxy или дескрипторы свойств.

### Как менять и что проверять

* Возвращает true при совпадении имени вызываемой функции с DEFAULT\_SIDE\_EFFECT\_CALLS — проверка в `if (DEFAULT_SIDE_EFFECT_CALLS.has(expressionText) || DEFAULT_SIDE_EFFECT_CALLS.has(propertyName))`.
* Обнаруживает присваивания process.env через BinaryExpression с оператором, содержащим `=`, и левой частью, начинающейся с `process.env` — проверка в `binary.getOperatorToken().getText().includes('=') && binary.getLeft().getText().startsWith('process.env')`.
