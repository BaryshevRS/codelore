import { Node, type SourceFile } from "ts-morph";
import type { SourceRange } from "../types.js";
import {
  computeSyntaxRole,
  hasLiteralContextualType,
  isInsideImportExport,
  isInsideJsDoc,
  isInsideTypeNode,
} from "./ast-helpers.js";

export interface ExtractedLiteral {
  value: string;
  syntaxRole: string;
  position: { offset: number; line: number; column: number };
}

const MIN_LITERAL_LENGTH = 4;

export function extractLiterals(sourceFile: SourceFile, range: SourceRange): ExtractedLiteral[] {
  const results: ExtractedLiteral[] = [];
  const seen = new Set<string>();

  sourceFile.forEachDescendant((node, traversal) => {
    if (node.getEnd() < range.startOffset || node.getStart() > range.endOffset) {
      traversal.skip();
      return;
    }
    if (!isAcceptableLiteral(node, range)) {
      return;
    }

    const value = node.getLiteralValue();
    if (value.length < MIN_LITERAL_LENGTH) {
      return;
    }

    const offset = node.getStart();
    const dedupKey = `${offset}:${value}`;
    if (seen.has(dedupKey)) {
      return;
    }
    seen.add(dedupKey);

    const { line, column } = sourceFile.getLineAndColumnAtPos(offset);
    results.push({
      value,
      syntaxRole: computeSyntaxRole(node),
      position: { offset, line, column },
    });
  });

  return results;
}

function isAcceptableLiteral(node: Node, range: SourceRange): node is Node & { getLiteralValue(): string } {
  if (node.getStart() < range.startOffset || node.getEnd() > range.endOffset) {
    return false;
  }
  if (!Node.isStringLiteral(node) && !Node.isNoSubstitutionTemplateLiteral(node)) {
    return false;
  }
  if (isInsideImportExport(node)) {
    return false;
  }
  if (isInsideJsDoc(node)) {
    return false;
  }
  if (isInsideTypeNode(node)) {
    return false;
  }
  // A literal whose contextual type is a declared literal union (e.g. entity.type === "class")
  // is a typed value enforced by the compiler, not a stringly-typed runtime contract.
  if (hasLiteralContextualType(node)) {
    return false;
  }
  return true;
}
