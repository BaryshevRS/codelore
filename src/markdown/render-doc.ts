import type { CodeloreConfig, DocState, DocStateBlock, DocStateSection } from "../types.js";
import { translationSourceFingerprint } from "./block-facets.js";
import { BLOCK_IDS, type BlockId } from "./block-ids.js";
import { type StaleGroup, staleCalloutText, translationPendingCalloutText } from "./callouts.js";
import { translationDocPath } from "./doc-paths.js";
import {
  type BlockLinkContext,
  buildDomainComposition,
  buildDomainRelations,
  buildPathTargets,
  type DocInfoMap,
  type EntityLinkMap,
  linkifyBlockBody,
  sectionLinkTargets,
} from "./linkify.js";
import { localeBundle } from "./locales.js";

/**
 * Renders a doc to markdown. `language` selects which language to render: omitted
 * (or the canonical language) renders `block.body` with the canonical headings;
 * a translation language renders `block.translations[language].body` with that
 * language's headings, and falls back to a "translation pending" callout when the
 * translation is missing or stale against the current canonical body.
 * `links` (entity id → documenting section) turns backtick symbol mentions into
 * links; omitted, mentions render as plain code spans. `docInfo` (canonical doc
 * path → heading + lead) feeds the domain tiers' member list.
 */
export function renderDoc(
  state: DocState,
  config: CodeloreConfig,
  language?: string,
  links?: EntityLinkMap,
  docInfo?: DocInfoMap
): string {
  if (state.sectionOrder.length === 0) {
    return "";
  }

  const translationLanguage = isTranslationLanguage(language, config) ? language : undefined;
  const renderedPathFor = (docPath: string): string =>
    translationLanguage ? translationDocPath(docPath, translationLanguage) : docPath;
  const renderedDocPath = renderedPathFor(state.docPath);
  const pathTargets = links ? buildPathTargets(links) : undefined;
  const navLabels = localeBundle(translationLanguage ?? config.docs.language).nav;

  const parts: string[] = [];
  for (const sectionId of state.sectionOrder) {
    const section = state.sections[sectionId];
    if (!section) {
      continue;
    }
    const linkContext: BlockLinkContext | undefined =
      links && pathTargets
        ? {
            symbolTargets: sectionLinkTargets(state, section, links),
            pathTargets,
            selfTarget: { docPath: state.docPath, anchor: section.anchor },
            renderedDocPath,
            renderedPathFor,
          }
        : undefined;
    let tierLead: string | undefined;
    if (links && pathTargets && docInfo && isTierSection(section)) {
      const composition = buildDomainComposition(
        section.depends,
        links,
        pathTargets,
        docInfo,
        renderedDocPath,
        renderedPathFor,
        navLabels.members
      );
      const relations = buildDomainRelations(
        section.depends,
        section.usedBy,
        links,
        docInfo,
        renderedDocPath,
        renderedPathFor,
        navLabels
      );
      tierLead = [composition, relations].filter((part) => part.length > 0).join("\n\n") || undefined;
    }
    parts.push(renderSection(section, config, language, linkContext, tierLead));
  }

  return `${parts.join("\n\n")}\n`;
}

/** A domain or project tier section — the ones that carry a structural nav line. */
function isTierSection(section: DocStateSection): boolean {
  const owner = section.owns[0];
  return owner !== undefined && (owner.startsWith("domain:") || owner.startsWith("project:"));
}

export function renderSection(
  section: DocStateSection,
  config: CodeloreConfig,
  language?: string,
  linkContext?: BlockLinkContext,
  navLine?: string
): string {
  const translationLanguage = isTranslationLanguage(language, config) ? language : undefined;
  // Callouts follow the language the doc is rendered in; the canonical doc uses
  // the canonical language, a translation doc uses its own.
  const calloutLanguage = translationLanguage ?? config.docs.language;
  const headings = translationLanguage
    ? (config.docs.blockHeadingsByLanguage[translationLanguage] ?? config.docs.blockHeadings)
    : config.docs.blockHeadings;

  const sectionHashes = "#".repeat(section.depth);
  const blockHashes = "#".repeat(section.depth + 1);
  const lines: string[] = [`${sectionHashes} ${section.heading}`];
  if (section.signature) {
    lines.push("", "```ts", section.signature, "```");
  }
  if (navLine !== undefined && navLine.length > 0) {
    lines.push("", navLine);
  }

  // Stale blocks are not rendered as empty headings; they collapse into a
  // per-reason summary banner below the section heading, so their withheld
  // bodies never leave a column of headings with repeated callouts behind.
  const staleGroups = new Map<string, StaleGroup>();
  const freshLines: string[] = [];

  for (const blockId of orderedRenderableBlocks(section)) {
    const block = section.blocks[blockId];
    if (!block?.rendered) {
      continue;
    }
    if (block.staleSince) {
      const key = `${block.staleReason ?? ""} ${block.staleSince}`;
      const group = staleGroups.get(key) ?? { reason: block.staleReason, since: block.staleSince, headings: [] };
      group.headings.push(headings[blockId]);
      staleGroups.set(key, group);
      continue;
    }
    freshLines.push("", `${blockHashes} ${headings[blockId]}`);
    const body = blockBody(block, translationLanguage, freshLines);
    if (body !== undefined && body.length > 0) {
      freshLines.push("", linkContext ? linkifyBlockBody(body, linkContext) : body);
    }
  }

  for (const group of staleGroups.values()) {
    lines.push("", staleCalloutText(calloutLanguage, group));
  }
  lines.push(...freshLines);

  return lines.join("\n");
}

/**
 * The rendered body for a fresh block in the requested language, or undefined
 * when a translation-pending callout was pushed instead. Stale blocks never reach
 * here — renderSection collapses them into a summary banner. A translation that is
 * missing or no longer matches the canonical body yields a pending callout rather
 * than stale translated prose.
 */
function blockBody(block: DocStateBlock, translationLanguage: string | undefined, lines: string[]): string | undefined {
  if (translationLanguage === undefined) {
    return block.body.trim();
  }
  const translation = block.translations?.[translationLanguage];
  if (!translation || translation.sourceFingerprint !== translationSourceFingerprint(block.body)) {
    lines.push("", translationPendingCalloutText(translationLanguage));
    return undefined;
  }
  return translation.body.trim();
}

function isTranslationLanguage(language: string | undefined, config: CodeloreConfig): language is string {
  return language !== undefined && language !== config.docs.language && config.docs.translations.includes(language);
}

function orderedRenderableBlocks(section: DocStateSection): BlockId[] {
  const allowed = new Set(section.allowedBlocks);
  const explicit = section.blockOrder.filter((id) => allowed.has(id));
  const explicitSet = new Set(explicit);
  const trailing = BLOCK_IDS.filter((id) => allowed.has(id) && !explicitSet.has(id));
  return [...explicit, ...trailing];
}
