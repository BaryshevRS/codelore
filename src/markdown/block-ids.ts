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
