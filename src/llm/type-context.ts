import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import type { CodeIndex } from "../types.js";
import { stripComments } from "./strip-comments.js";

export const TYPE_DECL_CAP = 1_500;
export const TYPE_CONTEXT_TOTAL_CAP = 6_000;

export interface TypeDeclaration {
  name: string;
  sourcePath: string;
  declaration: string;
}

/**
 * Declarations of type-only imports mentioned in the sections' source slices.
 * The verifier sees only an entity's own source; claims about imported types
 * ("X is not part of the input type") are unverifiable without these. Mention
 * in the slice is the filter: entity import metadata marks most of the file's
 * imports as referenced and over-selects by an order of magnitude.
 */
export async function collectTypeContext(args: {
  sections: Array<{ entityId: string; source: string }>;
  code: CodeIndex;
  rootDir: string;
}): Promise<TypeDeclaration[]> {
  const wantedByFile = new Map<string, Set<string>>();
  for (const section of args.sections) {
    const entity = args.code.entities[section.entityId];
    for (const spec of entity?.metadata?.imports.specifiers ?? []) {
      if (!spec.isTypeOnly || spec.isExternal || spec.isStdlib || spec.importedName === "*") {
        continue;
      }
      if (!mentioned(section.source, spec.localName)) {
        continue;
      }
      const resolved = spec.resolvedPath;
      if (!resolved || !args.code.fileToEntities[resolved]) {
        continue;
      }
      const names = wantedByFile.get(resolved) ?? new Set<string>();
      names.add(spec.importedName);
      wantedByFile.set(resolved, names);
    }
  }

  const declarations: TypeDeclaration[] = [];
  let total = 0;
  for (const sourcePath of [...wantedByFile.keys()].sort()) {
    const text = await readFile(join(args.rootDir, sourcePath), "utf8").catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    const sourceFile = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, false);
    for (const name of [...(wantedByFile.get(sourcePath) ?? [])].sort()) {
      const raw = findDeclaration(sourceFile, text, name);
      if (!raw) {
        continue;
      }
      const cleaned = stripComments(raw).trim();
      const capped = cleaned.length > TYPE_DECL_CAP ? `${cleaned.slice(0, TYPE_DECL_CAP)}\n// … truncated` : cleaned;
      if (total + capped.length > TYPE_CONTEXT_TOTAL_CAP) {
        return declarations;
      }
      total += capped.length;
      declarations.push({ name, sourcePath, declaration: capped });
    }
  }
  return declarations;
}

function findDeclaration(sourceFile: ts.SourceFile, text: string, name: string): string | undefined {
  for (const statement of sourceFile.statements) {
    const isTypeDeclaration =
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isClassDeclaration(statement);
    if (isTypeDeclaration && statement.name?.text === name) {
      return text.slice(statement.getStart(sourceFile), statement.end);
    }
  }
  return undefined;
}

function mentioned(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(source);
}
