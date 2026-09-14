import { DOMAIN_ID_PREFIX, PROJECT_ID } from "../indexer/domain-entities.js";
import type { DocSection, ProjectIndex, StaleBlockInfo } from "../types.js";
import {
  collectDepDocStaleBlocks,
  collectLanguageStaleBlocks,
  collectMemberDocStaleBlocks,
  collectStaleBlocks,
  collectTombstonedBlocks,
  collectUnwrittenBlocks,
  mergeStaleBlocks,
} from "./stale-detection.js";

/** The slug a tier section documents: a domain's own, "." for the project overview. */
function tierSlugOf(sectionId: string): string | undefined {
  if (sectionId.startsWith(DOMAIN_ID_PREFIX)) {
    return sectionId.slice(DOMAIN_ID_PREFIX.length);
  }
  return sectionId === PROJECT_ID ? "." : undefined;
}

/**
 * The one place that decides whether a doc block needs work, over one index snapshot.
 *
 * The tier view used to be a second, hand-written detector: it re-derived "never
 * written" from an empty purpose block and compared `memberDocsFingerprint` itself,
 * which meant a domain doc could be selected by rules no source doc was subject to —
 * including one the writer had already declined, re-asked on every run. A tier is now
 * stale exactly when one of its own blocks is, by the same passes as everything else.
 */
export class StaleDetector {
  constructor(
    private readonly index: ProjectIndex,
    private readonly canonicalLanguage: string | undefined
  ) {}

  /** Blocks whose text no longer matches what it was written against. */
  stale(sections: DocSection[]): StaleBlockInfo[] {
    return mergeStaleBlocks(
      collectStaleBlocks(sections, this.index.code.entities),
      collectDepDocStaleBlocks(sections, this.index),
      collectMemberDocStaleBlocks(sections, this.index),
      collectLanguageStaleBlocks(sections, this.canonicalLanguage)
    );
  }

  /** Allowed-but-empty blocks whose code moved on since anyone last asked about them. */
  unwritten(sections: DocSection[]): StaleBlockInfo[] {
    return collectUnwrittenBlocks(sections, this.index.code.entities);
  }

  /** Blocks already carrying a tombstone, so their body is withheld from the rendered doc. */
  tombstoned(sections: DocSection[]): StaleBlockInfo[] {
    return collectTombstonedBlocks(sections, this.index.code.entities);
  }

  /** Tier slugs to regenerate: a domain or the project overview with a stale or unwritten block. */
  tierSlugs(): Set<string> {
    const tierSections = Object.values(this.index.docs.sections).filter(
      (section) => tierSlugOf(section.id) !== undefined
    );
    const slugs = new Set<string>();
    for (const entry of [...this.stale(tierSections), ...this.unwritten(tierSections)]) {
      const slug = tierSlugOf(entry.sectionId);
      if (slug !== undefined) {
        slugs.add(slug);
      }
    }
    return slugs;
  }
}
