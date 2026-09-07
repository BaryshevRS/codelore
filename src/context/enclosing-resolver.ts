import { Node, type SourceFile } from "ts-morph";
import type { CodeIndex, RuntimeHit } from "../types.js";
import { computeSyntaxRole } from "./ast-helpers.js";
import type { FilteredHit } from "./ast-hit-filter.js";

export interface ResolveEnclosingInput {
  hit: FilteredHit;
  sourceFile: SourceFile;
  codeIndex: CodeIndex;
  indexFileKey: string;
}

export function resolveEnclosing(input: ResolveEnclosingInput): RuntimeHit | null {
  const { hit, sourceFile, codeIndex, indexFileKey } = input;

  const literalNode = sourceFile.getDescendantAtPos(hit.offset);
  if (!literalNode) {
    return null;
  }

  const container = walkUpToContainer(literalNode);
  const containerStart = container.getStart();
  const containerEnd = container.getEnd();

  const fileEntities = codeIndex.fileToEntities[indexFileKey] ?? [];
  const entityId =
    findSmallestContainingEntity(codeIndex, fileEntities, containerStart, containerEnd) ?? `file:${indexFileKey}`;

  return {
    entityId,
    literalValue: hit.literalValue,
    syntaxRole: computeSyntaxRole(literalNode),
    callsite: { line: hit.line, column: hit.column },
  };
}

function findSmallestContainingEntity(
  codeIndex: CodeIndex,
  fileEntityIds: string[],
  start: number,
  end: number
): string | null {
  let bestId: string | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const id of fileEntityIds) {
    const entity = codeIndex.entities[id];
    if (!entity || entity.type === "file") {
      continue;
    }
    if (entity.range.startOffset > start || entity.range.endOffset < end) {
      continue;
    }
    const size = entity.range.endOffset - entity.range.startOffset;
    if (size < bestSize) {
      bestSize = size;
      bestId = id;
    }
  }
  return bestId;
}

function walkUpToContainer(node: Node): Node {
  let current: Node | undefined = node;
  while (current) {
    if (isFunctionLikeContainer(current)) {
      return current;
    }
    if (Node.isClassDeclaration(current)) {
      return current;
    }
    const decoratedClass = enclosingDecoratedClass(current);
    if (decoratedClass) {
      return decoratedClass;
    }
    current = current.getParent();
  }
  return node.getSourceFile();
}

function isFunctionLikeContainer(node: Node): boolean {
  if (
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return true;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (parent && (Node.isVariableDeclaration(parent) || Node.isPropertyDeclaration(parent))) {
      return true;
    }
  }
  return false;
}

function enclosingDecoratedClass(node: Node): Node | null {
  if (!Node.isDecorator(node)) {
    return null;
  }
  return node.getParent() ?? null;
}
