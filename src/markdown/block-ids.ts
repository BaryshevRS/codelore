export const BLOCK_IDS = [
  "purpose",
  "responsibility",
  "invariants",
  "dependencies",
  "workflows",
  "limitations",
  "changeGuide",
] as const;

export type BlockId = (typeof BLOCK_IDS)[number];

/**
 * The blocks a caller needs before changing code, as opposed to before finding it:
 * contracts to keep, cases not covered, and how to change it safely. Purpose and
 * responsibility are excluded — a caller holding the file can read those from it.
 */
export const CONSTRAINT_BLOCKS: BlockId[] = ["invariants", "limitations", "changeGuide"];
