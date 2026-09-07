import { existsSync } from "node:fs";
import { join } from "node:path";
import fastGlob from "fast-glob";
import {
  type ClassDeclaration,
  type FunctionDeclaration,
  type ImportDeclaration,
  type MethodDeclaration,
  ModuleResolutionKind,
  Node,
  Project,
  ScriptTarget,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";
import { determineBlockInclusion } from "../analysis/block-inclusion.js";
import { analyzeClassCohesion } from "../analysis/class-cohesion.js";
import { decideDocumentationRoles } from "../analysis/decision-pass.js";
import { computeEntityMetrics } from "../analysis/entity-metrics.js";
import { detectPrivateWrappers } from "../analysis/wrapper-detector.js";
import type { CodeEntity, CodeIndex, CodeloreConfig, EntityFacets, EntityType, SourceRange } from "../types.js";
import { INDEX_VERSION } from "../types.js";
import { sha256 } from "../utils/hash.js";
import { isProbablyExcluded, relativeProjectPath, toPosixPath } from "../utils/path.js";

export interface CodeIndexScope {
  paths?: string[];
  files?: string[];
  entityIds?: string[];
}

interface EntityNodeRecord {
  entity: CodeEntity;
  node: Node;
  exportName?: string;
}

export async function buildCodeIndex(config: CodeloreConfig, scope?: CodeIndexScope): Promise<CodeIndex> {
  const normalizedScope = normalizeCodeIndexScope(scope);
  const project = createProject(config, normalizedScope);
  const records: EntityNodeRecord[] = [];
  const fileToEntities: Record<string, string[]> = {};

  for (const sourceFile of getProjectSourceFiles(project, config, normalizedScope)) {
    const relativePath = relativeProjectPath(config.rootDir, sourceFile.getFilePath());
    fileToEntities[relativePath] = [];
    const fileRecord = createFileRecord(config.rootDir, sourceFile);
    records.push(fileRecord);
    fileToEntities[relativePath].push(fileRecord.entity.id);

    for (const exportedRecord of collectExportedEntityRecords(config.rootDir, sourceFile)) {
      records.push(exportedRecord);
      fileToEntities[relativePath].push(exportedRecord.entity.id);
    }
  }

  const entities = Object.fromEntries(records.map((record) => [record.entity.id, record.entity]));
  populateDependencies(records, entities, config.rootDir);
  populateDocumentationMetadata(records, entities, config);

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    rootDir: config.rootDir,
    entities,
    fileToEntities,
  };
}

function createFileRecord(rootDir: string, sourceFile: SourceFile): EntityNodeRecord {
  const relativePath = relativeProjectPath(rootDir, sourceFile.getFilePath());
  const contentHash = sha256(sourceFile.getFullText());
  const entity: CodeEntity = {
    id: `file:${relativePath}`,
    type: "file",
    path: relativePath,
    name: relativePath,
    signature: relativePath,
    range: sourceRange(sourceFile, 0, sourceFile.getFullText().length),
    directDeps: [],
    directUsages: [],
    contentHash,
    facets: initialFacets(relativePath, relativePath, contentHash),
  };
  return { entity, node: sourceFile, exportName: relativePath };
}

function populateDocumentationMetadata(
  records: EntityNodeRecord[],
  entities: Record<string, CodeEntity>,
  config: CodeloreConfig
): void {
  const metrics = computeEntityMetrics(records, entities, config);
  const cohesion = analyzeClassCohesion(records, config);
  const wrappers = detectPrivateWrappers(records, entities);
  const decisions = decideDocumentationRoles(entities, metrics, cohesion, wrappers, config);

  for (const entity of Object.values(entities)) {
    const entityMetrics = metrics.get(entity.id);
    const decision = decisions.get(entity.id);
    if (entityMetrics && decision) {
      const inclusion = determineBlockInclusion(entity, entityMetrics, decision, config);
      entity.metadata = {
        ...entityMetrics,
        ...decision,
        allowedBlocks: inclusion.allowedBlocks,
        skippedBlocks: inclusion.skipped,
      };
    }
  }
}

function createProject(config: CodeloreConfig, scope: NormalizedCodeIndexScope): Project {
  const tsConfigFilePath = join(config.rootDir, "tsconfig.json");
  const sourceFiles = sourceFilesForScope(config, scope);
  const project = existsSync(tsConfigFilePath)
    ? new Project({
        tsConfigFilePath,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, checkJs: false },
      })
    : new Project({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          moduleResolution: ModuleResolutionKind.NodeNext,
          target: ScriptTarget.ES2022,
        },
      });

  project.addSourceFilesAtPaths(sourceFiles.map((path) => join(config.rootDir, path)));

  return project;
}

function getProjectSourceFiles(
  project: Project,
  config: CodeloreConfig,
  scope: NormalizedCodeIndexScope
): SourceFile[] {
  return project
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile())
    .filter((sourceFile) => {
      const relativePath = relativeProjectPath(config.rootDir, sourceFile.getFilePath());
      return (
        !relativePath.startsWith("..") &&
        !isProbablyExcluded(relativePath) &&
        isSupportedV1SourceFile(relativePath) &&
        isPathInCodeIndexScope(relativePath, scope)
      );
    })
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));
}

function isSupportedV1SourceFile(relativePath: string): boolean {
  return relativePath.endsWith(".ts") || relativePath.endsWith(".js");
}

interface NormalizedCodeIndexScope {
  paths: string[];
  files: string[];
  entityIds: string[];
  entityFiles: string[];
}

function normalizeCodeIndexScope(scope: CodeIndexScope | undefined): NormalizedCodeIndexScope {
  const paths = uniqueSorted((scope?.paths ?? []).map(normalizeScopePath).filter(Boolean));
  const files = uniqueSorted((scope?.files ?? []).map(normalizeScopePath).filter(Boolean));
  const entityIds = uniqueSorted(scope?.entityIds ?? []);
  const entityFiles = uniqueSorted(entityIds.map(filePathFromEntityId).filter(Boolean));

  return { paths, files, entityIds, entityFiles };
}

function normalizeScopePath(path: string): string {
  return toPosixPath(path).replace(/^\.\//, "").replace(/\/+$/, "");
}

function hasCodeIndexScope(scope: NormalizedCodeIndexScope): boolean {
  return scope.paths.length > 0 || scope.files.length > 0 || scope.entityFiles.length > 0;
}

function sourceGlobsForScope(config: CodeloreConfig, scope: NormalizedCodeIndexScope): string[] {
  if (!hasCodeIndexScope(scope)) {
    return config.sourceGlobs;
  }

  const scopedGlobs: string[] = [];

  for (const path of scope.paths) {
    scopedGlobs.push(isSupportedV1SourceFile(path) ? path : `${path}/**/*.{ts,js}`);
  }

  scopedGlobs.push(...scope.files, ...scope.entityFiles);
  return uniqueSorted(scopedGlobs);
}

function sourceFilesForScope(config: CodeloreConfig, scope: NormalizedCodeIndexScope): string[] {
  return fastGlob
    .sync(sourceGlobsForScope(config, scope), {
      cwd: config.rootDir,
      onlyFiles: true,
      dot: true,
      unique: true,
      absolute: false,
      ignore: config.excludeGlobs,
    })
    .map(toPosixPath)
    .filter((path) => isSupportedV1SourceFile(path))
    .filter((path) => !isProbablyExcluded(path))
    .filter((path) => isPathInCodeIndexScope(path, scope))
    .sort();
}

function isPathInCodeIndexScope(relativePath: string, scope: NormalizedCodeIndexScope): boolean {
  if (!hasCodeIndexScope(scope)) {
    return true;
  }

  return (
    scope.files.includes(relativePath) ||
    scope.entityFiles.includes(relativePath) ||
    scope.paths.some((path) => relativePath === path || relativePath.startsWith(`${path}/`))
  );
}

function filePathFromEntityId(entityId: string): string {
  if (entityId.startsWith("file:")) {
    return entityId.slice("file:".length);
  }

  if (entityId.startsWith("symbol:")) {
    const withoutPrefix = entityId.slice("symbol:".length);
    return withoutPrefix.split("#")[0] ?? "";
  }

  return "";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function collectExportedEntityRecords(rootDir: string, sourceFile: SourceFile): EntityNodeRecord[] {
  const records: EntityNodeRecord[] = [];
  const seenIds = new Set<string>();

  for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
    for (const declaration of declarations) {
      const found = entityRecordsForDeclaration(rootDir, sourceFile, exportName, declaration);
      for (const record of found) {
        if (seenIds.has(record.entity.id)) {
          continue;
        }

        seenIds.add(record.entity.id);
        records.push(record);
      }
    }
  }

  return records;
}

function entityRecordsForDeclaration(
  rootDir: string,
  sourceFile: SourceFile,
  exportName: string,
  declaration: Node
): EntityNodeRecord[] {
  if (Node.isFunctionDeclaration(declaration)) {
    return [createSymbolRecord(rootDir, sourceFile, exportName, "function", declaration)];
  }

  if (Node.isClassDeclaration(declaration)) {
    const classRecord = createSymbolRecord(rootDir, sourceFile, exportName, "class", declaration);
    const className = declaration.getName() ?? exportName;
    const methodRecords = declaration
      .getMethods()
      .map((method) => createMethodRecord(rootDir, sourceFile, className, method));
    return [classRecord, ...methodRecords];
  }

  if (Node.isVariableDeclaration(declaration) && isFunctionLikeVariable(declaration)) {
    return [createSymbolRecord(rootDir, sourceFile, exportName, "function", declaration)];
  }

  return [];
}

function createSymbolRecord(
  rootDir: string,
  sourceFile: SourceFile,
  exportName: string,
  type: Extract<EntityType, "function" | "class">,
  node: FunctionDeclaration | ClassDeclaration | VariableDeclaration
): EntityNodeRecord {
  const relativePath = relativeProjectPath(rootDir, sourceFile.getFilePath());
  const name = exportName;
  const signature = signatureForNode(name, node);
  const contentHash = sha256(node.getText());
  const entity: CodeEntity = {
    id: `symbol:${relativePath}#${name}`,
    type,
    path: relativePath,
    name,
    signature,
    range: nodeRange(node),
    directDeps: [],
    directUsages: [],
    contentHash,
    facets: initialFacets(signature, relativePath, contentHash),
  };
  return { entity, node, exportName };
}

function createMethodRecord(
  rootDir: string,
  sourceFile: SourceFile,
  className: string,
  method: MethodDeclaration
): EntityNodeRecord {
  const relativePath = relativeProjectPath(rootDir, sourceFile.getFilePath());
  const methodName = method.getName();
  const name = `${className}.${methodName}`;
  const signature = signatureForMethod(className, method);
  const contentHash = sha256(method.getText());
  const entity: CodeEntity = {
    id: `symbol:${relativePath}#${name}`,
    type: "method",
    path: relativePath,
    name,
    signature,
    range: nodeRange(method),
    directDeps: [],
    directUsages: [],
    contentHash,
    facets: initialFacets(signature, relativePath, contentHash),
  };
  return { entity, node: method, exportName: name };
}

function isFunctionLikeVariable(declaration: VariableDeclaration): boolean {
  const initializer = declaration.getInitializer();
  return Boolean(initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)));
}

function signatureForNode(name: string, node: FunctionDeclaration | ClassDeclaration | VariableDeclaration): string {
  if (Node.isFunctionDeclaration(node)) {
    return `${name}(${node
      .getParameters()
      .map((parameter) => parameter.getText())
      .join(", ")})${returnTypeText(node)}`;
  }

  if (Node.isClassDeclaration(node)) {
    const heritage = node.getExtends() ? ` extends ${node.getExtends()?.getText()}` : "";
    return `class ${name}${heritage}`;
  }

  const initializer = node.getInitializer();
  if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
    return `${name}(${initializer
      .getParameters()
      .map((parameter) => parameter.getText())
      .join(", ")})${returnTypeText(initializer)}`;
  }

  return name;
}

function signatureForMethod(className: string, method: MethodDeclaration): string {
  return `${className}.${method.getName()}(${method
    .getParameters()
    .map((parameter) => parameter.getText())
    .join(", ")})${returnTypeText(method)}`;
}

function returnTypeText(node: FunctionDeclaration | MethodDeclaration | ReturnTypeCapableNode): string {
  const returnTypeNode = node.getReturnTypeNode();
  if (returnTypeNode) {
    return `: ${returnTypeNode.getText()}`;
  }

  return "";
}

type ReturnTypeCapableNode = ReturnType<VariableDeclaration["getInitializerOrThrow"]> & {
  getReturnTypeNode(): Node | undefined;
};

function nodeRange(node: Node): SourceRange {
  return sourceRange(node.getSourceFile(), node.getStart(), node.getEnd());
}

function sourceRange(sourceFile: SourceFile, startOffset: number, endOffset: number): SourceRange {
  return {
    startOffset,
    endOffset,
    startLine: sourceFile.getLineAndColumnAtPos(startOffset).line,
    endLine: sourceFile.getLineAndColumnAtPos(endOffset).line,
  };
}

function buildExportIdIndex(records: EntityNodeRecord[]): Map<string, string> {
  const exportIdByFileAndName = new Map<string, string>();

  for (const record of records) {
    if (record.exportName && record.entity.type !== "file") {
      exportIdByFileAndName.set(`${record.entity.path}#${record.exportName}`, record.entity.id);
    }
  }

  return exportIdByFileAndName;
}

function extractIdentifiers(node: Node): Set<string> {
  return new Set(node.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
}

function extractNamespaceMemberAccesses(node: Node): Map<string, Set<string>> {
  const accesses = new Map<string, Set<string>>();
  for (const propertyAccess of node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const expression = propertyAccess.getExpression();
    if (!Node.isIdentifier(expression)) {
      continue;
    }
    const namespaceName = expression.getText();
    const members = accesses.get(namespaceName) ?? new Set<string>();
    members.add(propertyAccess.getName());
    accesses.set(namespaceName, members);
  }
  return accesses;
}

function resolveNamespaceImportDeps(
  decl: ImportDeclaration,
  namespaceAccesses: Map<string, Set<string>>,
  exportIdByFileAndName: Map<string, string>,
  importedPath: string
): Set<string> {
  const deps = new Set<string>();
  const namespaceImport = decl.getNamespaceImport();
  if (!namespaceImport) {
    return deps;
  }
  for (const member of namespaceAccesses.get(namespaceImport.getText()) ?? []) {
    const symbolId = exportIdByFileAndName.get(`${importedPath}#${member}`);
    if (symbolId) {
      deps.add(symbolId);
    }
  }
  return deps;
}

function resolveImportDeclaration(
  decl: ImportDeclaration,
  identifiers: Set<string>,
  namespaceAccesses: Map<string, Set<string>>,
  exportIdByFileAndName: Map<string, string>,
  rootDir: string
): Set<string> {
  const deps = new Set<string>();
  const importedFile = decl.getModuleSpecifierSourceFile();
  if (!importedFile) {
    return deps;
  }

  const importedPath = relativeProjectPath(rootDir, importedFile.getFilePath());

  for (const namedImport of decl.getNamedImports()) {
    const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
    if (!identifiers.has(localName)) {
      continue;
    }
    const exportedName = namedImport.getName();
    const symbolId = exportIdByFileAndName.get(`${importedPath}#${exportedName}`);
    if (symbolId) {
      deps.add(symbolId);
    }
  }

  const defaultImport = decl.getDefaultImport();
  if (defaultImport && identifiers.has(defaultImport.getText())) {
    const symbolId = exportIdByFileAndName.get(`${importedPath}#default`);
    if (symbolId) {
      deps.add(symbolId);
    }
  }

  for (const depId of resolveNamespaceImportDeps(decl, namespaceAccesses, exportIdByFileAndName, importedPath)) {
    deps.add(depId);
  }

  return deps;
}

function nodeKey(node: Node): string {
  return `${node.getSourceFile().getFilePath()}#${node.getStart()}`;
}

function buildDeclarationNodeIndex(records: EntityNodeRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    if (record.entity.type === "file") {
      continue;
    }
    index.set(nodeKey(record.node), record.entity.id);
  }
  return index;
}

function resolveLocalEntityDeps(record: EntityNodeRecord, declarationNodeIds: Map<string, string>): Set<string> {
  const deps = new Set<string>();
  if (record.entity.type === "file") {
    return deps;
  }

  const sourceFilePath = record.node.getSourceFile().getFilePath();
  for (const identifier of record.node.getDescendantsOfKind(SyntaxKind.Identifier)) {
    for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
      if (declaration.getSourceFile().getFilePath() !== sourceFilePath) {
        continue;
      }
      const entityId = declarationNodeIds.get(nodeKey(declaration));
      if (entityId && entityId !== record.entity.id) {
        deps.add(entityId);
      }
    }
  }
  return deps;
}

function buildReverseGraph(entities: Record<string, CodeEntity>): void {
  for (const entity of Object.values(entities)) {
    entity.directUsages = [];
  }
  for (const entity of Object.values(entities)) {
    for (const depId of entity.directDeps) {
      const dep = entities[depId];
      if (dep && !dep.directUsages.includes(entity.id)) {
        dep.directUsages.push(entity.id);
      }
    }
  }
  for (const entity of Object.values(entities)) {
    entity.directUsages.sort();
  }
}

function populateDependencies(
  records: EntityNodeRecord[],
  entities: Record<string, CodeEntity>,
  rootDir: string
): void {
  const exportIdByFileAndName = buildExportIdIndex(records);
  const declarationNodeIds = buildDeclarationNodeIndex(records);

  for (const record of records) {
    const sourceFile = record.node.getSourceFile();
    const identifiers = extractIdentifiers(record.node);
    const namespaceAccesses = extractNamespaceMemberAccesses(record.node);

    const directDeps = new Set<string>([
      ...sourceFile
        .getImportDeclarations()
        .flatMap((decl) => [
          ...resolveImportDeclaration(decl, identifiers, namespaceAccesses, exportIdByFileAndName, rootDir),
        ]),
      ...resolveLocalEntityDeps(record, declarationNodeIds),
    ]);

    directDeps.delete(record.entity.id);
    record.entity.directDeps = [...directDeps].filter((depId) => Boolean(entities[depId])).sort();
  }

  buildReverseGraph(entities);
  refreshGraphFacets(entities);
}

function initialFacets(signature: string, path: string, contentHash: string): EntityFacets {
  return {
    signature: sha256(signature),
    body: contentHash,
    deps: sha256(""),
    usage: sha256(""),
    placement: sha256(path),
  };
}

function refreshGraphFacets(entities: Record<string, CodeEntity>): void {
  for (const entity of Object.values(entities)) {
    entity.facets = {
      ...entity.facets,
      deps: sha256([...entity.directDeps].sort().join("|")),
      usage: sha256([...entity.directUsages].sort().join("|")),
    };
  }
}
