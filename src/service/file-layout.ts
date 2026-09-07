import type { CodeEntity } from "../types.js";

export interface PlannedSection {
  entity: CodeEntity;
  depth: 1 | 2;
  heading: string;
}

export function planFileLayout(entities: CodeEntity[]): PlannedSection[] {
  const sorted = [...entities].sort((left, right) => left.range.startOffset - right.range.startOffset);
  const classNames = new Set(sorted.filter((entity) => entity.type === "class").map((entity) => entity.name));

  return sorted.map((entity) => {
    if (entity.type === "file") {
      // The module section: heading is the file's basename, not the full path.
      return { entity, depth: 1 as const, heading: entity.name.split("/").pop() ?? entity.name };
    }
    if (entity.type === "method" && hasOwningClassInBatch(entity, classNames)) {
      const lastDot = entity.name.lastIndexOf(".");
      const methodName = lastDot === -1 ? entity.name : entity.name.slice(lastDot + 1);
      return { entity, depth: 2, heading: methodName };
    }
    return { entity, depth: 1, heading: entity.name };
  });
}

function hasOwningClassInBatch(entity: CodeEntity, classNames: Set<string>): boolean {
  const dotIndex = entity.name.indexOf(".");
  if (dotIndex === -1) {
    return false;
  }
  return classNames.has(entity.name.slice(0, dotIndex));
}
