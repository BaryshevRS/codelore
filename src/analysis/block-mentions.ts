/** A dependency a block could be leaning on: its doc's source path and the names declared there. */
export interface MentionCandidate {
  sourcePath: string;
  names: readonly string[];
}

/** Bare-name matching below this length produces noise, not evidence ("id", "map"). */
const MIN_BARE_NAME = 4;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsName(body: string, names: readonly string[]): boolean {
  const usable = names.filter((name) => name.length >= MIN_BARE_NAME);
  if (usable.length === 0) {
    return false;
  }
  // Backticked first: that is how the writer is told to name code, and it is exact.
  if (
    usable.some((name) => body.includes(`\`${name}\``) || body.includes(`\`${name}(`) || body.includes(`\`${name}.`))
  ) {
    return true;
  }
  // Then the same names in plain prose. Measured against the strict form on this
  // repo it costs 48 blocks out of 2121 and buys back the case the whole fallback
  // exists for: `CodeloreError` is discussed by name without backticks far more
  // often than with them.
  return new RegExp(`\\b(${usable.map(escapeForRegExp).join("|")})\\b`).test(body);
}

function mentionsPath(body: string, sourcePath: string): boolean {
  const base = sourcePath.split("/").pop() ?? sourcePath;
  return body.includes(sourcePath) || body.includes(base) || body.includes(base.replace(/\.[cm]?[jt]s$/, ""));
}

/**
 * The dependencies a block's prose actually leans on, read out of the text itself.
 *
 * Invalidation asks "did anything this file imports change?" and rewrites every block
 * of the file when the answer is yes. Measured on this repo that is 2121 block
 * rewrites where 201 blocks so much as name the thing that changed. A block that
 * never mentions a dependency was not written from its documentation, so a change
 * there cannot have made the block wrong.
 *
 * Judged from the text rather than from the writer's own `refs` list on purpose: the
 * list is the model's claim and can silently omit what it used, while the prose is
 * evidence. The two are complementary — `refs` can be unioned in later — but the text
 * is the half that does not need the model to be honest, and it applies to every block
 * already on disk without regenerating a single one.
 */
export function mentionedDependencies(body: string, candidates: readonly MentionCandidate[]): string[] {
  const text = body.trim();
  if (text === "") {
    return [];
  }
  return candidates
    .filter((candidate) => mentionsPath(text, candidate.sourcePath) || mentionsName(text, candidate.names))
    .map((candidate) => candidate.sourcePath);
}
