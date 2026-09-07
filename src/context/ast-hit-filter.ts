import { existsSync, readFileSync } from "node:fs";
import { Node, Project, type SourceFile } from "ts-morph";
import { hasLiteralContextualType, isInsideImportExport, isInsideJsDoc, isInsideTypeNode } from "./ast-helpers.js";
import type { RipgrepHit } from "./ripgrep-runner.js";

export interface FilteredHit extends RipgrepHit {
  literalValue: string;
  offset: number;
}

export class AstHitFilter {
  private readonly project: Project;
  private readonly sourceFiles = new Map<string, SourceFile | null>();

  constructor(project?: Project) {
    this.project = project ?? new Project({ useInMemoryFileSystem: false, compilerOptions: { allowJs: true } });
  }

  filter(hit: RipgrepHit, expectedLiteral: string): FilteredHit | null {
    const sourceFile = this.getSourceFile(hit.file);
    if (!sourceFile) {
      return null;
    }

    const offset = lineColumnToOffset(sourceFile, hit.line, hit.column);
    if (offset < 0) {
      return null;
    }

    const node = sourceFile.getDescendantAtPos(offset);
    if (!node || !isAcceptedLiteralNode(node, expectedLiteral)) {
      return null;
    }

    return { ...hit, literalValue: expectedLiteral, offset: node.getStart() };
  }

  getSourceFile(filePath: string): SourceFile | null {
    const cached = this.sourceFiles.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    if (!existsSync(filePath)) {
      this.sourceFiles.set(filePath, null);
      return null;
    }

    try {
      const text = readFileSync(filePath, "utf8");
      const sourceFile = this.project.createSourceFile(filePath, text, { overwrite: true });
      this.sourceFiles.set(filePath, sourceFile);
      return sourceFile;
    } catch {
      this.sourceFiles.set(filePath, null);
      return null;
    }
  }
}

function isAcceptedLiteralNode(node: Node, expectedLiteral: string): boolean {
  if (!Node.isStringLiteral(node) && !Node.isNoSubstitutionTemplateLiteral(node)) {
    return false;
  }
  if (node.getLiteralValue() !== expectedLiteral) {
    return false;
  }
  if (isInsideImportExport(node)) {
    return false;
  }
  if (isInsideJsDoc(node)) {
    return false;
  }
  // Matches in type space (type EntityType = "class" | ...) are not call sites.
  if (isInsideTypeNode(node)) {
    return false;
  }
  if (hasLiteralContextualType(node)) {
    return false;
  }
  return true;
}

function lineColumnToOffset(sourceFile: SourceFile, line: number, column: number): number {
  const fullText = sourceFile.getFullText();
  let currentLine = 1;
  let lineStart = 0;
  for (let i = 0; i < fullText.length && currentLine < line; i++) {
    if (fullText[i] === "\n") {
      currentLine++;
      lineStart = i + 1;
    }
  }
  if (currentLine !== line) {
    return -1;
  }
  return lineStart + Math.max(0, column - 1);
}
