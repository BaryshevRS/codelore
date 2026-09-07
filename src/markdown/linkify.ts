import { posix } from "node:path";
import type { DocState, DocStateSection } from "../types.js";

/** The doc section that documents an entity: where its prose lives and its heading anchor. */
export interface LinkTarget {
  docPath: string;
  anchor: string;
}

/** The doc that documents a source file; `anchor` only when the doc has a file-level section. */
export interface FileDocTarget {
  docPath: string;
  anchor?: string;
}

/** entity id → the section that owns it, across every doc state. */
export type EntityLinkMap = ReadonlyMap<string, LinkTarget>;

/** source-file path → the doc documenting it (unambiguously). */
export type FileDocMap = ReadonlyMap<string, FileDocTarget>;

/** Synthetic domain-entity id prefix (mirrors indexer/domain-entities; kept local to avoid a layer import). */
const DOMAIN_ID = "domain:";

export const MENTIONED_SYMBOL_PATTERN = /`([^`\n]+)`/g;
export const SYMBOL_CANDIDATE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/;
export const MENTIONED_PATH_PATTERN = /(?:src|tests?|scripts|docs|\.codelore)\/[\w./@-]*\.\w{1,6}/g;

const CALL_MENTION = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\([^()]*\)$/;

/** Everything linkifyBlockBody needs to resolve one section's mentions. */
export interface BlockLinkContext {
  /** Symbol name → unique documenting section, already scoped to this section's context. */
  symbolTargets: ReadonlyMap<string, LinkTarget>;
  /** Source-file path → its documenting doc; paths are globally unique, no scoping. */
  pathTargets: FileDocMap;
  /** The section being rendered; a mention resolving here stays plain (self-link). */
  selfTarget: LinkTarget;
  /** The .md file being written (the translation sibling when rendering a translation). */
  renderedDocPath: string;
  /** Maps a target's canonical docPath into the rendered language. */
  renderedPathFor: (docPath: string) => string;
}

/**
 * Maps every owned entity id to its documenting section. Built from doc states —
 * the source of truth — so absorbed entities resolve to the section that actually
 * hosts their prose, wherever it lives.
 */
export function buildEntityLinkMap(states: Iterable<DocState>): Map<string, LinkTarget> {
  const links = new Map<string, LinkTarget>();
  for (const state of states) {
    addDocToLinkMap(links, state);
  }
  return links;
}

export function removeDocFromLinkMap(links: Map<string, LinkTarget>, docPath: string): void {
  for (const [entityId, target] of links) {
    if (target.docPath === docPath) {
      links.delete(entityId);
    }
  }
}

export function addDocToLinkMap(links: Map<string, LinkTarget>, state: DocState): void {
  removeDocFromLinkMap(links, state.docPath);
  for (const sectionId of state.sectionOrder) {
    const section = state.sections[sectionId];
    if (!section) {
      continue;
    }
    for (const entityId of section.owns) {
      links.set(entityId, { docPath: state.docPath, anchor: section.anchor });
    }
  }
}

/** The source-file path an entity id belongs to (`file:PATH` or `symbol:PATH#name`). */
function pathOfEntityId(entityId: string): string | undefined {
  if (entityId.startsWith("file:")) {
    return entityId.slice("file:".length);
  }
  if (entityId.startsWith("symbol:")) {
    const hash = entityId.indexOf("#");
    return hash > 0 ? entityId.slice("symbol:".length, hash) : entityId.slice("symbol:".length);
  }
  return undefined;
}

/**
 * source-file path → the doc that documents it. A file's entities may be split
 * across sections but they live in one doc; when a path resolves to more than one
 * doc it is dropped (ambiguous). The anchor is the doc's file-level section when it
 * has one, else absent — a path mention then links to the doc's top. Most docs have
 * no file-level section (their file is represented only by its symbols).
 */
export function buildPathTargets(links: EntityLinkMap): Map<string, FileDocTarget> {
  const docPathsByFile = new Map<string, Set<string>>();
  const fileAnchor = new Map<string, string>();
  for (const [entityId, target] of links) {
    const path = pathOfEntityId(entityId);
    if (path === undefined) {
      continue;
    }
    const docPaths = docPathsByFile.get(path) ?? new Set<string>();
    docPaths.add(target.docPath);
    docPathsByFile.set(path, docPaths);
    if (entityId.startsWith("file:")) {
      fileAnchor.set(path, target.anchor);
    }
  }

  const paths = new Map<string, FileDocTarget>();
  for (const [path, docPaths] of docPathsByFile) {
    if (docPaths.size !== 1) {
      continue;
    }
    const [docPath] = docPaths;
    const anchor = fileAnchor.get(path);
    paths.set(path, anchor === undefined ? { docPath } : { docPath, anchor });
  }
  return paths;
}

/** Prose names an entity id can be mentioned by: `Name`, plus the bare method name for `Class.method`. */
function namesOfEntityId(entityId: string): string[] {
  if (!entityId.startsWith("symbol:")) {
    return [];
  }
  const hash = entityId.indexOf("#");
  if (hash < 0 || hash === entityId.length - 1) {
    return [];
  }
  const name = entityId.slice(hash + 1);
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    return [name, name.slice(dot + 1)];
  }
  return [name];
}

/**
 * Names mentionable in this section's prose, resolved to their documenting
 * sections. Candidates mirror the validator's section context: entities owned by
 * this doc plus the section's depends/usedBy — and a `file:` id in that context
 * stands for its whole file, so every entity documented in that file's doc is a
 * candidate (state records callers at file granularity; the prose names their
 * symbols). A name is linkable only when it resolves to exactly one distinct
 * target; the containing section itself is never a target (a self-link is noise).
 */
export function sectionLinkTargets(
  state: DocState,
  section: DocStateSection,
  links: EntityLinkMap
): Map<string, LinkTarget> {
  const contextIds = new Set<string>();
  for (const sectionId of state.sectionOrder) {
    for (const entityId of state.sections[sectionId]?.owns ?? []) {
      contextIds.add(entityId);
    }
  }
  for (const entityId of section.depends) {
    contextIds.add(entityId);
  }
  for (const entityId of section.usedBy) {
    contextIds.add(entityId);
  }

  const candidateIds = new Set(contextIds);
  const contextDocPaths = new Set<string>();
  for (const entityId of contextIds) {
    if (entityId.startsWith("file:")) {
      const fileTarget = links.get(entityId);
      if (fileTarget) {
        contextDocPaths.add(fileTarget.docPath);
      }
    }
  }
  if (contextDocPaths.size > 0) {
    for (const [entityId, target] of links) {
      if (contextDocPaths.has(target.docPath)) {
        candidateIds.add(entityId);
      }
    }
  }

  const byName = new Map<string, Map<string, LinkTarget>>();
  for (const entityId of candidateIds) {
    const target = links.get(entityId);
    if (!target) {
      continue;
    }
    for (const name of namesOfEntityId(entityId)) {
      const targets = byName.get(name) ?? new Map<string, LinkTarget>();
      targets.set(`${target.docPath}#${target.anchor}`, target);
      byName.set(name, targets);
    }
  }

  const resolved = new Map<string, LinkTarget>();
  for (const [name, targets] of byName) {
    if (targets.size !== 1) {
      continue;
    }
    const [target] = targets.values();
    if (target.docPath === state.docPath && target.anchor === section.anchor) {
      continue;
    }
    resolved.set(name, target);
  }
  return resolved;
}

/**
 * Rewrites mentions that resolve to documented sections into markdown links:
 * backtick symbol mentions (bare, `name()`, or `name(args)` with flat argument
 * lists) via `symbolTargets`, and bare source-file paths in plain prose via
 * `pathTargets`. Operates on the rendered output only — state bodies never carry
 * links. Fenced code regions and the insides of inline code spans (for paths)
 * are left untouched.
 */
export function linkifyBlockBody(body: string, context: BlockLinkContext): string {
  if (context.symbolTargets.size === 0 && context.pathTargets.size === 0) {
    return body;
  }
  let inFence = false;
  const lines = body.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return line;
    }
    // Symbols first: linkifyPaths must see which docs the line already links to.
    return linkifyPaths(linkifySymbols(line, context), context);
  });
  return lines.join("\n");
}

/** The symbol a backtick span mentions: a bare/dotted name, with an optional call-argument suffix. */
function mentionName(inner: string): string | undefined {
  const trimmed = inner.trim();
  if (SYMBOL_CANDIDATE.test(trimmed)) {
    return trimmed;
  }
  return CALL_MENTION.exec(trimmed)?.[1] ?? undefined;
}

/** Links backtick symbol mentions only; path mentions are linkifyPaths' job (it needs the symbol links in place). */
function linkifySymbols(line: string, context: BlockLinkContext): string {
  return line.replace(MENTIONED_SYMBOL_PATTERN, (span, inner: string) => {
    const name = mentionName(inner);
    const symbolTarget = name === undefined ? undefined : context.symbolTargets.get(name);
    return symbolTarget ? `[${span}](${hrefFor(symbolTarget, context)})` : span;
  });
}

/** A path target for a mention, or undefined when it does not resolve or points at the current doc. */
function resolvePathMention(path: string, context: BlockLinkContext): FileDocTarget | undefined {
  const target = context.pathTargets.get(path);
  // A mention of the current doc's own file links to itself — noise.
  if (!target || target.docPath === context.selfTarget.docPath) {
    return undefined;
  }
  return target;
}

/** Splits a line so existing markdown links and inline code spans land in the odd slots. */
const PROTECTED_SEGMENT = /(\[[^\]\n]*\]\([^)\n]*\)|`[^`\n]*`)/;

/**
 * Links path mentions: bare paths in plain prose, and backtick spans that are
 * *entirely* a source path (a path inside a larger code fragment — an import
 * statement, a call — stays code). Runs after linkifySymbols and skips a path
 * whose doc this line already links to: the dominant prose shape is
 * "`symbol` (src/its/file.ts)", and linking both symbol and path to the same
 * doc is pure noise — the path stays plain there.
 */
function linkifyPaths(line: string, context: BlockLinkContext): string {
  if (context.pathTargets.size === 0 || !line.includes("/")) {
    return line;
  }
  const linkedFiles = new Set<string>();
  for (const match of line.matchAll(/\]\(([^)#\n]+)(?:#[^)\n]*)?\)/g)) {
    linkedFiles.add(match[1]);
  }
  const linkPath = (target: FileDocTarget): string | undefined => {
    const href = hrefFor(target, context);
    const file = href.split("#")[0];
    if (file === "" || linkedFiles.has(file)) {
      return undefined;
    }
    linkedFiles.add(file);
    return href;
  };

  const segments = line.split(PROTECTED_SEGMENT);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i % 2 === 1) {
      // Protected slot: an existing link stays; a code span links only when its
      // whole content is a path.
      if (segment.startsWith("`") && segment.endsWith("`")) {
        const target = resolvePathMention(segment.slice(1, -1).trim(), context);
        const href = target ? linkPath(target) : undefined;
        if (href) {
          segments[i] = `[${segment}](${href})`;
        }
      }
      continue;
    }
    segments[i] = segment.replace(MENTIONED_PATH_PATTERN, (path) => {
      const target = resolvePathMention(path, context);
      const href = target ? linkPath(target) : undefined;
      return href ? `[${path}](${href})` : path;
    });
  }
  return segments.join("");
}

function hrefFor(target: LinkTarget | FileDocTarget, context: BlockLinkContext): string {
  return hrefBetween(target, context.renderedDocPath, context.renderedPathFor);
}

function hrefBetween(
  target: LinkTarget | FileDocTarget,
  renderedDocPath: string,
  renderedPathFor: (docPath: string) => string
): string {
  const suffix = target.anchor === undefined ? "" : `#${target.anchor}`;
  const targetFile = renderedPathFor(target.docPath);
  if (targetFile === renderedDocPath) {
    return suffix === "" ? "#" : suffix;
  }
  // Encode only the path (spaces, unusual chars); leave the anchor raw so
  // non-ascii headings (e.g. Cyrillic domain names) read cleanly and still resolve.
  const relPath = posix.relative(posix.dirname(renderedDocPath), targetFile);
  return `${encodeURI(relPath)}${suffix}`;
}

/** Labels for the domain/project structural sections, one set per rendered language. */
export interface NavLabels {
  members: string;
  dependsOn: string;
  usedBy: string;
}

/** Per-doc info the domain tiers render: display heading and a one-line lead. */
export interface DocInfo {
  heading: string;
  lead?: string;
}
export type DocInfoMap = ReadonlyMap<string, DocInfo>;

/** The first sentence of a doc's leading prose — its `purpose` block, first section that has one. */
export function docLead(state: DocState): string | undefined {
  for (const sectionId of state.sectionOrder) {
    const sentence = purposeLead(state, sectionId);
    if (sentence) {
      return sentence;
    }
  }
  return undefined;
}

/**
 * Every section's one-line purpose, joined — the whole file's responsibilities,
 * not just the first entity's. Used to describe a file to the domain partition so
 * a multi-entity file is not misrepresented by whichever section happens to be first.
 */
export function docResponsibilities(state: DocState): string | undefined {
  const lines: string[] = [];
  for (const sectionId of state.sectionOrder) {
    const sentence = purposeLead(state, sectionId);
    if (sentence) {
      const heading = state.sections[sectionId]?.heading?.trim();
      lines.push(heading ? `${heading}: ${sentence}` : sentence);
    }
  }
  return lines.length > 0 ? lines.join(" ") : undefined;
}

function purposeLead(state: DocState, sectionId: string): string | undefined {
  const body = state.sections[sectionId]?.blocks.purpose?.body?.trim();
  if (!body) {
    return undefined;
  }
  const sentence = body.split(/(?<=[.!?])\s/)[0].trim();
  return sentence.length > 0 ? sentence : undefined;
}

/** Resolves a tier member id (file: or domain:) to its doc target, or undefined if undocumented. */
function memberTarget(id: string, links: EntityLinkMap, pathTargets: FileDocMap): FileDocTarget | undefined {
  if (id.startsWith("file:")) {
    // A member file's doc usually has no file-level section, so resolve by path.
    return links.get(id) ?? pathTargets.get(id.slice("file:".length));
  }
  return links.get(id);
}

function memberDepends(depends: readonly string[]): { members: string[]; depDomains: string[] } {
  const files = depends.filter((id) => id.startsWith("file:"));
  const domainDeps = depends.filter((id) => id.startsWith(DOMAIN_ID));
  // A domain's members are its files; the project's members are its domains.
  return files.length > 0 ? { members: files, depDomains: domainDeps } : { members: domainDeps, depDomains: [] };
}

/**
 * The "Состав" section for a domain or project: a bullet per member linking to its
 * doc, with the member's one-line lead when its doc has one. A file member reads as
 * its basename, a domain member as its doc heading (display name). Undocumented
 * members are dropped. Returns "" when no member resolves.
 */
export function buildDomainComposition(
  depends: readonly string[],
  links: EntityLinkMap,
  pathTargets: FileDocMap,
  docInfo: DocInfoMap,
  renderedDocPath: string,
  renderedPathFor: (docPath: string) => string,
  membersLabel: string
): string {
  const { members } = memberDepends(depends);
  const rows: string[] = [];
  for (const id of members) {
    const target = memberTarget(id, links, pathTargets);
    if (!target) {
      continue;
    }
    const info = docInfo.get(target.docPath);
    const text = id.startsWith("file:")
      ? id.slice(id.lastIndexOf("/") + 1).replace(/\.(ts|js|tsx|jsx)$/, "")
      : (info?.heading ?? id.slice(DOMAIN_ID.length));
    const href = hrefBetween(target, renderedDocPath, renderedPathFor);
    rows.push(info?.lead ? `- [${text}](${href}) — ${info.lead}` : `- [${text}](${href})`);
  }
  return rows.length > 0 ? `## ${membersLabel}\n\n${rows.join("\n")}` : "";
}

/**
 * The compact relations line for a domain: the domains it depends on and the ones
 * that depend on it, each linked by display name. Empty for the project (it has no
 * peer domains). Returns "" when nothing resolves.
 */
export function buildDomainRelations(
  depends: readonly string[],
  usedBy: readonly string[],
  links: EntityLinkMap,
  docInfo: DocInfoMap,
  renderedDocPath: string,
  renderedPathFor: (docPath: string) => string,
  labels: NavLabels
): string {
  const { depDomains } = memberDepends(depends);
  const linkDomain = (id: string): string | undefined => {
    const target = links.get(id);
    if (!target) {
      return undefined;
    }
    const text = docInfo.get(target.docPath)?.heading ?? id.slice(DOMAIN_ID.length);
    return `[${text}](${hrefBetween(target, renderedDocPath, renderedPathFor)})`;
  };
  const dependsRendered = depDomains.map(linkDomain).filter((x): x is string => x !== undefined);
  const usedByRendered = usedBy
    .filter((id) => id.startsWith(DOMAIN_ID))
    .map(linkDomain)
    .filter((x): x is string => x !== undefined);

  const rows: string[] = [];
  if (dependsRendered.length > 0) {
    rows.push(`**${labels.dependsOn}:** ${dependsRendered.join(" · ")}`);
  }
  if (usedByRendered.length > 0) {
    rows.push(`**${labels.usedBy}:** ${usedByRendered.join(" · ")}`);
  }
  return rows.join("\n");
}
