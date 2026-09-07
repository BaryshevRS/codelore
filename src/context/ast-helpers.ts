import { Node, SyntaxKind, type Type } from "ts-morph";

export function isInsideImportExport(node: Node): boolean {
  return (
    node.getFirstAncestor((ancestor) => Node.isImportDeclaration(ancestor) || Node.isExportDeclaration(ancestor)) !=
    null
  );
}

export function isInsideJsDoc(node: Node): boolean {
  return node.getFirstAncestor((ancestor) => Node.isJSDoc(ancestor)) != null;
}

export function isInsideTypeNode(node: Node): boolean {
  return node.getFirstAncestor((ancestor) => Node.isLiteralTypeNode(ancestor)) != null;
}

export function hasLiteralContextualType(node: Node): boolean {
  if (!Node.isExpression(node)) {
    return false;
  }
  const compared = comparedOperandType(node);
  if (compared && isStringLiteralOrLiteralUnion(compared)) {
    return true;
  }
  const contextual = node.getContextualType();
  if (!contextual) {
    return false;
  }
  return isStringLiteralOrLiteralUnion(contextual);
}

// Equality operands and case clauses are not contextually typed by the checker,
// so the counterpart's type has to be read directly.
function comparedOperandType(node: Node): Type | null {
  const parent = node.getParent();
  if (!parent) {
    return null;
  }
  if (Node.isBinaryExpression(parent) && isEqualityOperator(parent.getOperatorToken().getKind())) {
    const other = parent.getLeft() === node ? parent.getRight() : parent.getLeft();
    return other.getType();
  }
  if (Node.isCaseClause(parent) && parent.getExpression() === node) {
    const switchStatement = parent.getFirstAncestor(Node.isSwitchStatement);
    return switchStatement ? switchStatement.getExpression().getType() : null;
  }
  return null;
}

function isEqualityOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.EqualsEqualsToken ||
    kind === SyntaxKind.EqualsEqualsEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function isStringLiteralOrLiteralUnion(type: Type): boolean {
  if (type.isStringLiteral()) {
    return true;
  }
  if (!type.isUnion()) {
    return false;
  }
  const members = type.getUnionTypes();
  return members.length > 0 && members.every((member) => member.isStringLiteral());
}

export function computeSyntaxRole(node: Node): string {
  const parent = node.getParent();
  if (!parent) {
    return "SourceFile";
  }
  const argumentRole = computeArgumentRole(parent, node);
  if (argumentRole) {
    return argumentRole;
  }
  return computeSimpleParentRole(parent, node) ?? parent.getKindName();
}

function computeArgumentRole(parent: Node, node: Node): string | null {
  if (Node.isCallExpression(parent)) {
    const argIndex = parent.getArguments().findIndex((arg) => arg === node);
    return argIndex >= 0 ? `CallExpression.arguments[${argIndex}]` : "CallExpression.expression";
  }
  if (Node.isNewExpression(parent)) {
    const argIndex = (parent.getArguments() ?? []).findIndex((arg) => arg === node);
    return argIndex >= 0 ? `NewExpression.arguments[${argIndex}]` : "NewExpression.expression";
  }
  if (Node.isArrayLiteralExpression(parent)) {
    const index = parent.getElements().findIndex((el) => el === node);
    return `ArrayLiteralExpression.elements[${index}]`;
  }
  return null;
}

function computeSimpleParentRole(parent: Node, node: Node): string | null {
  if (Node.isPropertyAssignment(parent)) return "PropertyAssignment.initializer";
  if (Node.isDecorator(parent)) return "Decorator.expression";
  if (Node.isVariableDeclaration(parent)) return "VariableDeclaration.initializer";
  if (Node.isReturnStatement(parent)) return "ReturnStatement.expression";
  if (Node.isElementAccessExpression(parent)) return "ElementAccessExpression.argument";
  if (Node.isBinaryExpression(parent)) {
    return `BinaryExpression.${parent.getLeft() === node ? "left" : "right"}`;
  }
  return null;
}
