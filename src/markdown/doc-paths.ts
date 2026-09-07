const CODELORE_MD_SUFFIX = ".codelore.md";

/** Sibling path for a translation of `docPath`, e.g. `foo.codelore.md` → `foo.<lang>.codelore.md`. */
export function translationDocPath(docPath: string, language: string): string {
  if (docPath.endsWith(CODELORE_MD_SUFFIX)) {
    return `${docPath.slice(0, -CODELORE_MD_SUFFIX.length)}.${language}${CODELORE_MD_SUFFIX}`;
  }
  if (docPath.endsWith(".md")) {
    return `${docPath.slice(0, -".md".length)}.${language}.md`;
  }
  return `${docPath}.${language}`;
}
