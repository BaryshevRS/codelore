import en from "../locales/en.json" with { type: "json" };
import ru from "../locales/ru.json" with { type: "json" };
import type { BlockId } from "./block-ids.js";

// One bundle per language: section headings, drift-reason phrases, and callout
// templates. Each bundle's `headings` is a complete Record<BlockId, string>; a
// missing key fails the build here, not at render time. `reasons` maps the
// machine drift tokens from staleReasonFor to human phrases (an unmapped token
// renders as-is). To add a language: drop `src/locales/<lang>.json` and list it
// below — heading language follows `docs.language`, callouts follow the language
// the doc is rendered in, both falling back to English.
export interface LocaleBundle {
  headings: Record<BlockId, string>;
  reasons: Record<string, string>;
  callouts: {
    stale: string;
    translationPending: string;
  };
  nav: {
    members: string;
    dependsOn: string;
    usedBy: string;
  };
}

const LOCALES: Record<string, LocaleBundle> = { en, ru };

export function localeBundle(language: string | undefined): LocaleBundle {
  return (language && LOCALES[language]) || LOCALES.en;
}

/**
 * Resolves the rendered heading text for each block from the locale bundle that
 * matches `language`. `language` is the single knob: there is no separate
 * heading-language setting to drift out of sync with the prose language sent to
 * the writer.
 */
export function resolveBlockHeadings(language: string | undefined): Record<BlockId, string> {
  return localeBundle(language).headings;
}
