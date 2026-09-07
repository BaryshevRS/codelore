import { type ClassDeclaration, type MethodDeclaration, Node, SyntaxKind } from "ts-morph";
import type { CodeEntity, CodeloreConfig } from "../types.js";
import type { AnalysisEntityRecord } from "./entity-metrics.js";

export interface ClassCohesion {
  classEntityId: string;
  fieldOverlap: number;
  graphConnectedness: boolean;
  cohesive: boolean;
  absorbedMethodIds: string[];
}

export function analyzeClassCohesion(
  records: AnalysisEntityRecord[],
  config: CodeloreConfig
): Map<string, ClassCohesion> {
  const byId = new Map(records.map((record) => [record.entity.id, record]));
  const result = new Map<string, ClassCohesion>();
  const fieldOverlapThreshold = config.thresholds.classFieldOverlap;

  for (const record of records) {
    if (!Node.isClassDeclaration(record.node)) {
      continue;
    }

    const className = record.entity.name;
    const methodRecords = records
      .filter(
        (candidate) => candidate.entity.path === record.entity.path && candidate.entity.name.startsWith(`${className}.`)
      )
      .filter((candidate) => byId.has(candidate.entity.id));
    const methods = methodRecords
      .map((candidate) => ({
        entity: candidate.entity,
        method: candidate.node,
      }))
      .filter((candidate): candidate is { entity: CodeEntity; method: MethodDeclaration } =>
        Node.isMethodDeclaration(candidate.method)
      );

    const fieldOverlap = calculateFieldOverlap(methods.map((item) => item.method));
    const graphConnectedness = isInternalCallGraphConnected(
      record.node,
      methods.map((item) => item.method)
    );
    const cohesive = fieldOverlap >= fieldOverlapThreshold || graphConnectedness;

    result.set(record.entity.id, {
      classEntityId: record.entity.id,
      fieldOverlap,
      graphConnectedness,
      cohesive,
      absorbedMethodIds: cohesive ? methods.map((item) => item.entity.id) : [],
    });
  }

  return result;
}

function calculateFieldOverlap(methods: MethodDeclaration[]): number {
  if (methods.length < 2) {
    return methods.length === 1 ? 1 : 0;
  }

  const fieldsByMethod = methods.map((method) => thisFieldNames(method));
  let overlappingPairs = 0;
  let totalPairs = 0;

  for (let left = 0; left < fieldsByMethod.length; left += 1) {
    for (let right = left + 1; right < fieldsByMethod.length; right += 1) {
      totalPairs += 1;
      if (setsOverlap(fieldsByMethod[left], fieldsByMethod[right])) {
        overlappingPairs += 1;
      }
    }
  }

  return totalPairs === 0 ? 0 : overlappingPairs / totalPairs;
}

function isInternalCallGraphConnected(classNode: ClassDeclaration, methods: MethodDeclaration[]): boolean {
  if (methods.length < 2) {
    return methods.length === 1;
  }

  const methodNames = new Set(methods.map((method) => method.getName()));
  const adjacency = buildInternalCallGraph(methods, methodNames);

  if (!classContainsAllMethods(classNode, methodNames)) {
    return false;
  }

  const first = methodNames.values().next().value;
  if (!first) {
    return false;
  }

  const visited = new Set<string>();
  const queue = [first];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      queue.push(next);
    }
  }

  return visited.size === methodNames.size;
}

function buildInternalCallGraph(methods: MethodDeclaration[], methodNames: Set<string>): Map<string, Set<string>> {
  const adjacency = new Map(methods.map((method) => [method.getName(), new Set<string>()]));

  for (const method of methods) {
    addInternalCallEdges(method, methodNames, adjacency);
  }

  return adjacency;
}

function addInternalCallEdges(
  method: MethodDeclaration,
  methodNames: Set<string>,
  adjacency: Map<string, Set<string>>
): void {
  const from = method.getName();
  for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const target = sameClassCallTarget(call.getExpression(), methodNames);
    if (!target) {
      continue;
    }

    adjacency.get(from)?.add(target);
    adjacency.get(target)?.add(from);
  }
}

function sameClassCallTarget(expression: Node, methodNames: Set<string>): string | undefined {
  if (!Node.isPropertyAccessExpression(expression) || !isThisExpression(expression.getExpression().getText())) {
    return undefined;
  }

  const target = expression.getName();
  return methodNames.has(target) ? target : undefined;
}

function classContainsAllMethods(classNode: ClassDeclaration, methodNames: Set<string>): boolean {
  const classMethodNames = new Set(classNode.getMethods().map((method) => method.getName()));
  for (const methodName of methodNames) {
    if (!classMethodNames.has(methodName)) {
      return false;
    }
  }
  return true;
}

function thisFieldNames(method: MethodDeclaration): Set<string> {
  const names = new Set<string>();
  for (const access of method.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (isThisExpression(access.getExpression().getText())) {
      names.add(access.getName());
    }
  }
  return names;
}

function setsOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function isThisExpression(text: string): boolean {
  return text === "this";
}
