import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ImportDeclaration, Node, type SourceFile, SyntaxKind } from "ts-morph";
import type {
  CodeEntity,
  CodeloreConfig,
  EntityGlobals,
  EntityGlobalUsage,
  EntityImportSpecifier,
  EntityImports,
  EntityMetrics,
} from "../types.js";
import { relativeProjectPath } from "../utils/path.js";

const BASELINE_GLOBALS_SKIP = new Set([
  "Math",
  "JSON",
  "Object",
  "Array",
  "Promise",
  "Date",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "console",
  "Reflect",
  "Proxy",
  "Buffer",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Infinity",
  "NaN",
  "undefined",
  "null",
  "true",
  "false",
  "void",
]);

export interface AnalysisEntityRecord {
  entity: CodeEntity;
  node: Node;
  exportName?: string;
}

const DEFAULT_SIDE_EFFECT_MODULES = new Set([
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
  "node:net",
  "net",
  "node:http",
  "http",
  "node:https",
  "https",
  "node:child_process",
  "child_process",
]);

const DEFAULT_SIDE_EFFECT_CALLS = new Set([
  "fetch",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "process.nextTick",
  "process.exit",
  "process.kill",
  "spawn",
  "exec",
  "fork",
  "query",
]);

export function computeEntityMetrics(
  records: AnalysisEntityRecord[],
  entities: Record<string, CodeEntity>,
  config: CodeloreConfig
): Map<string, EntityMetrics> {
  const entryPointFiles = resolveEntryPointFiles(config);
  const metrics = new Map<string, EntityMetrics>();
  const fileUsageCache = new Map<string, Set<string>>();

  for (const record of records) {
    const sourceFile = record.node.getSourceFile();
    const filePath = sourceFile.getFilePath();
    let fileUsage = fileUsageCache.get(filePath);
    if (!fileUsage) {
      fileUsage = collectFileUsageIdentifiers(sourceFile);
      fileUsageCache.set(filePath, fileUsage);
    }
    const entityIdentifiers = collectIdentifierUsage(record.node);
    metrics.set(record.entity.id, {
      statementCount: countStatements(record.node),
      inDegree: effectiveDirectUsages(record.entity, entities).length,
      hasSideEffects: hasSideEffects(record.node, config),
      isEntryPoint: isEntryPoint(record, config, entryPointFiles),
      imports: collectEntityImports(record, fileUsage, config),
      globals: collectEntityGlobals(record, entityIdentifiers, config),
    });
  }

  return metrics;
}

function collectIdentifierUsage(node: Node): Set<string> {
  return new Set(node.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
}

function collectFileUsageIdentifiers(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) {
      continue;
    }
    names.add(id.getText());
  }
  return names;
}

function collectEntityImports(
  record: AnalysisEntityRecord,
  identifiers: Set<string>,
  config: CodeloreConfig
): EntityImports {
  const specifiers: EntityImportSpecifier[] = [];
  const stdlibPrefixes = config.blockInclusion.stdlibPrefixes;
  const sourceFile = record.node.getSourceFile();

  for (const decl of sourceFile.getImportDeclarations()) {
    specifiers.push(...specifiersForImport(decl, identifiers, stdlibPrefixes, config.rootDir));
  }

  return { specifiers };
}

function specifiersForImport(
  decl: ImportDeclaration,
  identifiers: Set<string>,
  stdlibPrefixes: string[],
  rootDir: string
): EntityImportSpecifier[] {
  const moduleSpecifier = decl.getModuleSpecifierValue();
  const isStdlib = matchesStdlib(moduleSpecifier, stdlibPrefixes);
  const isExternal = !moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/");
  const declarationIsTypeOnly = decl.isTypeOnly();
  const resolvedFile = decl.getModuleSpecifierSourceFile();
  const resolvedPath = resolvedFile ? relativeProjectPath(rootDir, resolvedFile.getFilePath()) : undefined;
  const result: EntityImportSpecifier[] = [];

  const namespaceImport = decl.getNamespaceImport();
  if (namespaceImport) {
    const localName = namespaceImport.getText();
    result.push({
      localName,
      importedName: "*",
      moduleSpecifier,
      resolvedPath,
      isTypeOnly: declarationIsTypeOnly,
      isStdlib,
      isExternal,
      isReferenced: identifiers.has(localName),
    });
  }

  const defaultImport = decl.getDefaultImport();
  if (defaultImport) {
    const localName = defaultImport.getText();
    result.push({
      localName,
      importedName: "default",
      moduleSpecifier,
      resolvedPath,
      isTypeOnly: declarationIsTypeOnly,
      isStdlib,
      isExternal,
      isReferenced: identifiers.has(localName),
    });
  }

  for (const named of decl.getNamedImports()) {
    const importedName = named.getName();
    const localName = named.getAliasNode()?.getText() ?? importedName;
    const specifierIsTypeOnly = declarationIsTypeOnly || named.isTypeOnly();
    result.push({
      localName,
      importedName,
      moduleSpecifier,
      resolvedPath,
      isTypeOnly: specifierIsTypeOnly,
      isStdlib,
      isExternal,
      isReferenced: identifiers.has(localName),
    });
  }

  return result;
}

function matchesStdlib(moduleSpecifier: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (moduleSpecifier === prefix || moduleSpecifier.startsWith(`${prefix}/`)) {
      return true;
    }

    if (prefix.endsWith(":") && moduleSpecifier.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function collectEntityGlobals(
  record: AnalysisEntityRecord,
  identifiers: Set<string>,
  config: CodeloreConfig
): EntityGlobals {
  const significant = new Set(config.blockInclusion.significantGlobals);
  const importedLocals = importedLocalNames(record.node.getSourceFile());
  const locallyDeclared = locallyDeclaredNames(record.node);
  const used = new Map<string, EntityGlobalUsage>();

  for (const name of identifiers) {
    if (!isEligibleGlobal(name, significant, importedLocals, locallyDeclared)) {
      continue;
    }

    if (!used.has(name)) {
      used.set(name, { name, access: name });
    }
  }

  // Enrich with property-access expression context for documentation purposes (process.env.X etc.).
  const body = bodyNode(record.node) ?? record.node;
  for (const access of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const rootName = rootIdentifierOfAccess(access);
    if (!rootName || !isEligibleGlobal(rootName, significant, importedLocals, locallyDeclared)) {
      continue;
    }

    const fullAccess = access.getText();
    const existing = used.get(rootName);
    if (!existing || existing.access === rootName) {
      used.set(rootName, { name: rootName, access: fullAccess });
    }
  }

  return { used: [...used.values()].sort((left, right) => left.name.localeCompare(right.name)) };
}

function isEligibleGlobal(
  name: string,
  significant: Set<string>,
  importedLocals: Set<string>,
  locallyDeclared: Set<string>
): boolean {
  return (
    significant.has(name) && !importedLocals.has(name) && !locallyDeclared.has(name) && !BASELINE_GLOBALS_SKIP.has(name)
  );
}

function rootIdentifierOfAccess(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current && Node.isPropertyAccessExpression(current)) {
    current = current.getExpression();
  }
  return current && Node.isIdentifier(current) ? current.getText() : undefined;
}

function importedLocalNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const decl of sourceFile.getImportDeclarations()) {
    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport) {
      names.add(namespaceImport.getText());
    }

    const defaultImport = decl.getDefaultImport();
    if (defaultImport) {
      names.add(defaultImport.getText());
    }

    for (const named of decl.getNamedImports()) {
      names.add(named.getAliasNode()?.getText() ?? named.getName());
    }
  }

  return names;
}

function locallyDeclaredNames(node: Node): Set<string> {
  const names = new Set<string>();
  const body = bodyNode(node) ?? node;

  for (const variable of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = variable.getName();
    if (name) {
      names.add(name);
    }
  }

  for (const param of body.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const name = param.getName();
    if (name) {
      names.add(name);
    }
  }

  for (const fn of body.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    if (name) {
      names.add(name);
    }
  }

  for (const cls of body.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
    const name = cls.getName();
    if (name) {
      names.add(name);
    }
  }

  return names;
}

export function effectiveDirectUsages(entity: CodeEntity, entities: Record<string, CodeEntity>): string[] {
  const owningClassId = owningClassEntityId(entity);
  const owningFileId = `file:${entity.path}`;
  return entity.directUsages.filter(
    (usageId) => usageId !== owningClassId && usageId !== owningFileId && Boolean(entities[usageId])
  );
}

function owningClassEntityId(entity: CodeEntity): string | undefined {
  if (entity.type !== "method") {
    return undefined;
  }

  const className = entity.name.split(".")[0];
  return `symbol:${entity.path}#${className}`;
}

export function countStatements(node: Node): number {
  if (Node.isSourceFile(node)) {
    return node
      .getStatements()
      .reduce((sum, statement) => sum + (isStatementSignal(statement) ? 1 : countStatements(statement)), 0);
  }

  if (Node.isClassDeclaration(node)) {
    return node.getMethods().reduce((sum, method) => sum + countStatements(method), 0);
  }

  const body = bodyNode(node);
  if (!body) {
    return 0;
  }

  return body.getDescendants().filter(isStatementSignal).length;
}

export function hasSideEffects(node: Node, config: CodeloreConfig): boolean {
  const body = Node.isClassDeclaration(node) || Node.isSourceFile(node) ? node : bodyNode(node);
  if (!body) {
    return false;
  }

  const sideEffectImports = sideEffectImportNames(node.getSourceFile(), config);
  const extraPatterns = config.sideEffectPatterns ?? [];

  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const expressionText = expression.getText();
    const rootName = expressionText.split(/[.(]/)[0] ?? expressionText;
    const propertyName = Node.isPropertyAccessExpression(expression) ? expression.getName() : expressionText;

    if (
      sideEffectImports.has(rootName) ||
      DEFAULT_SIDE_EFFECT_CALLS.has(expressionText) ||
      DEFAULT_SIDE_EFFECT_CALLS.has(propertyName) ||
      extraPatterns.some((pattern) => expressionText.includes(pattern))
    ) {
      return true;
    }
  }

  return body
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .some(
      (binary) =>
        binary.getOperatorToken().getText().includes("=") && binary.getLeft().getText().startsWith("process.env")
    );
}

function bodyNode(node: Node): Node | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getBody();
  }

  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer.getBody();
    }
  }

  return undefined;
}

function isStatementSignal(node: Node): boolean {
  switch (node.getKind()) {
    case SyntaxKind.VariableStatement:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.IfStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.TryStatement:
    case SyntaxKind.ThrowStatement:
      return true;
    default:
      return false;
  }
}

function sideEffectImportNames(sourceFile: SourceFile, config: CodeloreConfig): Set<string> {
  const configured = new Set(config.sideEffectPatterns ?? []);
  const names = new Set<string>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    const moduleName = declaration.getModuleSpecifierValue();
    if (!DEFAULT_SIDE_EFFECT_MODULES.has(moduleName) && !configured.has(moduleName)) {
      continue;
    }

    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) {
      names.add(namespaceImport.getText());
    }

    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      names.add(defaultImport.getText());
    }

    for (const namedImport of declaration.getNamedImports()) {
      names.add(namedImport.getAliasNode()?.getText() ?? namedImport.getName());
    }
  }

  return names;
}

function isEntryPoint(record: AnalysisEntityRecord, config: CodeloreConfig, entryPointFiles: Set<string>): boolean {
  const explicit = config.entryPoints?.explicit ?? [];
  if (explicit.includes(record.entity.id) || explicit.includes(record.entity.name)) {
    return true;
  }

  if (entryPointFiles.has(record.entity.path)) {
    return true;
  }

  if ((config.entryPoints?.pathPatterns ?? []).some((pattern) => matchesPathPattern(record.entity.path, pattern))) {
    return true;
  }

  if (hasConfiguredDecorator(record.node, config.entryPoints?.decorators ?? [])) {
    return true;
  }

  return false;
}

function hasConfiguredDecorator(node: Node, decorators: string[]): boolean {
  if (decorators.length === 0) {
    return false;
  }

  const decorated = Node.isClassDeclaration(node) || Node.isMethodDeclaration(node) ? node : undefined;

  return (
    decorated?.getDecorators().some((decorator) => {
      const expression = decorator.getExpression();
      const name = Node.isCallExpression(expression) ? expression.getExpression().getText() : expression.getText();
      return decorators.includes(name);
    }) ?? false
  );
}

function resolveEntryPointFiles(config: CodeloreConfig): Set<string> {
  const files = new Set(config.entryPoints?.barrelFiles ?? []);
  const packageJsonPath = join(config.rootDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return files;
  }

  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    main?: unknown;
    exports?: unknown;
    bin?: unknown;
  };

  addPackagePath(files, parsed.main);
  addPackageExports(files, parsed.exports);
  addPackageBin(files, parsed.bin);
  return files;
}

function addPackageExports(files: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    addPackagePath(files, value);
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      addPackageExports(files, nested);
    }
  }
}

function addPackageBin(files: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    addPackagePath(files, value);
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      addPackageBin(files, nested);
    }
  }
}

function addPackagePath(files: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }

  const normalized = value.replace(/^\.\//, "");
  files.add(normalized);
  if (normalized.startsWith("dist/")) {
    files.add(normalized.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
  }
}

function matchesPathPattern(path: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, "");
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -"**".length);
    return path.startsWith(prefix);
  }

  if (normalized.includes("*")) {
    const escaped = normalized
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*");
    return new RegExp(`^${escaped}$`).test(path);
  }

  return path === normalized || path.startsWith(`${normalized}/`);
}
