import { type MethodDeclaration, Node, SyntaxKind } from "ts-morph";
import type { CodeEntity } from "../types.js";
import { type AnalysisEntityRecord, countStatements, effectiveDirectUsages } from "./entity-metrics.js";

export interface WrapperDetection {
  anchorByPublicId: Map<string, string>;
  absorbedPrivateById: Map<string, string>;
  privateMethodIds: Set<string>;
}

export function detectPrivateWrappers(
  records: AnalysisEntityRecord[],
  entities: Record<string, CodeEntity>
): WrapperDetection {
  const anchorByPublicId = new Map<string, string>();
  const absorbedPrivateById = new Map<string, string>();
  const privateMethodIds = new Set<string>();

  for (const methods of groupMethodsByClass(records).values()) {
    recordWrappersForClass(methods, entities, anchorByPublicId, absorbedPrivateById, privateMethodIds);
  }

  return { anchorByPublicId, absorbedPrivateById, privateMethodIds };
}

function recordWrappersForClass(
  methods: Array<AnalysisEntityRecord & { node: MethodDeclaration }>,
  entities: Record<string, CodeEntity>,
  anchorByPublicId: Map<string, string>,
  absorbedPrivateById: Map<string, string>,
  privateMethodIds: Set<string>
): void {
  const privateRecords = methods.filter((record) => isPrivateMethod(record.node));
  for (const privateRecord of privateRecords) {
    privateMethodIds.add(privateRecord.entity.id);
  }

  const privateMethods = new Map(privateRecords.map((record) => [methodShortName(record.entity), record]));
  for (const publicRecord of methods.filter((record) => !isPrivateMethod(record.node))) {
    recordPublicWrapper(publicRecord, privateMethods, entities, anchorByPublicId, absorbedPrivateById);
  }
}

function recordPublicWrapper(
  publicRecord: AnalysisEntityRecord & { node: MethodDeclaration },
  privateMethods: Map<string, AnalysisEntityRecord & { node: MethodDeclaration }>,
  entities: Record<string, CodeEntity>,
  anchorByPublicId: Map<string, string>,
  absorbedPrivateById: Map<string, string>
): void {
  const publicStatementCount = countStatements(publicRecord.node);
  if (publicStatementCount < 1 || publicStatementCount > 2) {
    return;
  }

  for (const calledName of sameClassPrivateCalls(publicRecord.node, privateMethods)) {
    const privateRecord = privateMethods.get(calledName);
    if (privateRecord && isAnchorPrivate(publicStatementCount, privateRecord, entities)) {
      anchorByPublicId.set(publicRecord.entity.id, privateRecord.entity.id);
      absorbedPrivateById.set(privateRecord.entity.id, publicRecord.entity.id);
    }
  }
}

function isAnchorPrivate(
  publicStatementCount: number,
  privateRecord: AnalysisEntityRecord & { node: MethodDeclaration },
  entities: Record<string, CodeEntity>
): boolean {
  const privateEntity = entities[privateRecord.entity.id];
  if (!privateEntity || effectiveDirectUsages(privateEntity, entities).length !== 1) {
    return false;
  }

  const privateStatementCount = countStatements(privateRecord.node);
  return privateStatementCount / Math.max(publicStatementCount, 1) >= 3;
}

function groupMethodsByClass(
  records: AnalysisEntityRecord[]
): Map<string, Array<AnalysisEntityRecord & { node: MethodDeclaration }>> {
  const grouped = new Map<string, Array<AnalysisEntityRecord & { node: MethodDeclaration }>>();

  for (const record of records) {
    if (!Node.isMethodDeclaration(record.node)) {
      continue;
    }

    const className = record.entity.name.split(".")[0];
    const key = `${record.entity.path}#${className}`;
    const group = grouped.get(key) ?? [];
    group.push(record as AnalysisEntityRecord & { node: MethodDeclaration });
    grouped.set(key, group);
  }

  return grouped;
}

function sameClassPrivateCalls(
  method: MethodDeclaration,
  privateMethods: Map<string, AnalysisEntityRecord & { node: MethodDeclaration }>
): string[] {
  const calls: string[] = [];

  for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getExpression().getText() !== "this") {
      continue;
    }

    const name = expression.getName();
    if (privateMethods.has(name)) {
      calls.push(name);
    }
  }

  return calls;
}

function methodShortName(entity: CodeEntity): string {
  return entity.name.split(".").at(-1) ?? entity.name;
}

function isPrivateMethod(node: Node | undefined): node is MethodDeclaration {
  return (
    Node.isMethodDeclaration(node) &&
    node.getModifiers().some((modifier) => modifier.getKind() === SyntaxKind.PrivateKeyword)
  );
}
