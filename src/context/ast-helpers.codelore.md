# isInsideImportExport

## Зачем это нужно

Отсеивает строковые литералы, находящиеся внутри `import` или `export` деклараций.

## Что делает

- Не проверяет другие виды деклараций (например, `require`).
- Не определяет, является ли узел частью модульного specifier — только проверяет наличие предка-декларации.
- Не различает `import` и `export` — возвращает `true` для обоих.

## На что можно положиться

- Возвращает `true` для любого узла, у которого есть предок `ImportDeclaration` или `ExportDeclaration`.
- Возвращает `false` для узлов вне таких деклараций.
- Не бросает исключений.

## От чего зависит

- `ts-morph` — предоставляет `Node` и методы `isImportDeclaration`, `isExportDeclaration`, `getFirstAncestor`.

## Кто и как использует

Вызывается из `isAcceptedLiteralNode` в [`src/context/ast-hit-filter.ts`](ast-hit-filter.codelore.md) и `isAcceptableLiteral` в [`src/context/literal-extractor.ts`](literal-extractor.codelore.md). Обе функции проверяют, что строковый литерал не находится внутри `import`/`export`, прежде чем считать его валидным литералом для дальнейшей обработки.

## Чего не делает

Не обрабатывает динамические импорты (`import()`) — они не являются `ImportDeclaration`.

# isInsideJsDoc

## Зачем это нужно

Отсеивает строковые литералы, находящиеся внутри JSDoc-комментариев.

## Что делает

- Не проверяет другие виды комментариев (однострочные, блочные).
- Не различает типы JSDoc-тегов — возвращает `true` для любого предка `JSDoc`.

## На что можно положиться

- Возвращает `true` для любого узла, у которого есть предок `JSDoc`.
- Возвращает `false` для узлов вне JSDoc.
- Не бросает исключений.

## От чего зависит

- `ts-morph` — предоставляет `Node` и метод `isJSDoc`, `getFirstAncestor`.

## Кто и как использует

Вызывается из `isAcceptedLiteralNode` в [`src/context/ast-hit-filter.ts`](ast-hit-filter.codelore.md) и `isAcceptableLiteral` в [`src/context/literal-extractor.ts`](literal-extractor.codelore.md). Обе функции проверяют, что строковый литерал не находится внутри JSDoc, прежде чем считать его валидным литералом для дальнейшей обработки.

## Чего не делает

Не обрабатывает комментарии, не являющиеся JSDoc (например, `//` или `/* */`).

# isInsideTypeNode

## Зачем это нужно

Отсеивает строковые литералы, находящиеся внутри type-аннотаций (литеральных union-типов).

## Что делает

- Не проверяет другие type-узлы (например, `TypeReference`, `ArrayType`).
- Не различает конкретные литеральные union-типы — возвращает `true` для любого предка `LiteralTypeNode`.

## На что можно положиться

- Возвращает `true` для любого узла, у которого есть предок `LiteralTypeNode`.
- Возвращает `false` для узлов вне `LiteralTypeNode`.
- Не бросает исключений.

## От чего зависит

- `ts-morph` — предоставляет `Node` и метод `isLiteralTypeNode`, `getFirstAncestor`.

## Кто и как использует

Вызывается из `isAcceptedLiteralNode` в [`src/context/ast-hit-filter.ts`](ast-hit-filter.codelore.md) и `isAcceptableLiteral` в [`src/context/literal-extractor.ts`](literal-extractor.codelore.md). Обе функции проверяют, что строковый литерал не находится внутри type-аннотации, прежде чем считать его валидным литералом для дальнейшей обработки.

## Чего не делает

Не обрабатывает литералы в других type-контекстах, например, в `TypeAliasDeclaration` без `LiteralTypeNode`.

# hasLiteralContextualType

## Зачем это нужно

Определяет, является ли строковый литерал частью выражения, чей контекстный тип — строковый литерал или union строковых литералов.

## Что делает

- Не проверяет контекстный тип для не-выражений (возвращает `false`).
- Для выражений в бинарных операциях сравнения и `case`-клаузах читает тип противоположного операнда напрямую, так как TypeScript не даёт контекстный тип в этих позициях.
- Не проверяет другие синтаксические конструкции, где контекстный тип может быть неявным (например, `return` в функции с возвращаемым типом).

## На что можно положиться

- Возвращает `false` для узлов, не являющихся `Expression`.
- Для выражений в бинарных операциях сравнения (`===`, `!==`, `==`, `!=`) и `case`-клаузах проверяет тип противоположного операнда.
- Для остальных выражений использует `getContextualType()`.
- Возвращает `true`, если контекстный тип — строковый литерал или union строковых литералов.
- Не бросает исключений.

## От чего зависит

- `ts-morph` — предоставляет `Node`, `Type`, `SyntaxKind`, методы `isExpression`, `isBinaryExpression`, `isCaseClause`, `isSwitchStatement`, `getContextualType`, `getType`, `isStringLiteral`, `isUnion`, `getUnionTypes`.

## Кто и как использует

Вызывается из `isAcceptedLiteralNode` в [`src/context/ast-hit-filter.ts`](ast-hit-filter.codelore.md) и `isAcceptableLiteral` в [`src/context/literal-extractor.ts`](literal-extractor.codelore.md). Обе функции проверяют, что строковый литерал не имеет контекстного типа-литерала, прежде чем считать его валидным литералом для дальнейшей обработки.

## Чего не делает

- Не обрабатывает контекстный тип для выражений в `return` или присваиваниях, где тип может быть выведен из объявления переменной или возвращаемого типа функции.
- Полагается на `getContextualType()`, который может возвращать `undefined` для некоторых сложных случаев (например, при ошибках типизации).

## Как менять и что проверять

1. Если изменится логика определения контекстного типа (например, добавятся новые синтаксические конструкции), проверить, что `comparedOperandType` покрывает все необходимые случаи.
2. Если изменится определение `isStringLiteralOrLiteralUnion` (например, добавится поддержка `TemplateLiteralType`), убедиться, что это не приведёт к ложным срабатываниям для литералов, которые должны быть отфильтрованы.

# computeSyntaxRole

## Зачем это нужно

Определяет синтаксическую роль строкового литерала в AST (например, аргумент вызова, инициализатор свойства).

## Что делает

- Не определяет семантическую роль (например, «это имя сущности»).
- Не обрабатывает все возможные родительские узлы — для неизвестных возвращает `getKindName()` родителя.
- Для аргументов вызова и `new`-выражений возвращает строку с индексом аргумента.

## На что можно положиться

- Всегда возвращает непустую строку.
- Для узлов без родителя возвращает `"SourceFile"`.
- Для аргументов вызова возвращает `"CallExpression.arguments[N]"` или `"NewExpression.arguments[N]"`.
- Для элементов массива возвращает `"ArrayLiteralExpression.elements[N]"`.
- Для известных простых ролей (инициализатор, выражение) возвращает соответствующую строку.
- Для неизвестных родительских узлов возвращает `getKindName()` родителя.
- Не бросает исключений.

## От чего зависит

- `ts-morph` — предоставляет `Node`, методы `isCallExpression`, `isNewExpression`, `isArrayLiteralExpression`, `isPropertyAssignment`, `isDecorator`, `isVariableDeclaration`, `isReturnStatement`, `isElementAccessExpression`, `isBinaryExpression`, `getParent`, `getArguments`, `getElements`, `getLeft`, `getRight`, `getKindName`.

## Кто и как использует

Вызывается из [`resolveEnclosing`](enclosing-resolver.codelore.md#resolveenclosing) в `src/context/enclosing-resolver.ts` и [`extractLiterals`](literal-extractor.codelore.md#extractliterals) в `src/context/literal-extractor.ts`. В [`resolveEnclosing`](enclosing-resolver.codelore.md#resolveenclosing) используется для заполнения поля `syntaxRole` в `RuntimeHit`. В [`extractLiterals`](literal-extractor.codelore.md#extractliterals) — для заполнения поля `syntaxRole` в `ExtractedLiteral`.

## Чего не делает

- Не обрабатывает все возможные синтаксические конструкции (например, `TaggedTemplateExpression`, `JsxExpression`).
- Для неизвестных конструкций возвращает `getKindName()`, что может быть менее информативно.

## Как менять и что проверять

1. Если добавляется новая синтаксическая конструкция (например, `TaggedTemplateExpression`), необходимо добавить соответствующую проверку в `computeArgumentRole` или `computeSimpleParentRole`.
2. Если изменяется логика определения индекса аргумента (например, для spread-элементов), проверить, что `findIndex` корректно обрабатывает новые случаи.
