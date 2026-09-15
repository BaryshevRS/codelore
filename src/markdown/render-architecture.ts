import { posix } from "node:path";
import { type DepGraph, dependencyWaves } from "../graph/waves.js";
import type { CodeIndex, DocState, DocStateSection } from "../types.js";
import type { BlockId } from "./block-ids.js";
import { localeBundle } from "./locales.js";

/** Where the generated page lives; every link is resolved relative to it. */
export const ARCHITECTURE_DOC_PATH = "ARCHITECTURE.md";

const PROJECT_ID = "project:";
const DOMAIN_ID = "domain:";
const FILE_ID = "file:";
const SYMBOL_ID = "symbol:";

export interface ArchitectureInput {
  /** Every doc state: the project tier, the domain tier, and the per-file docs. */
  states: readonly DocState[];
  /** Entry points, and the file set coverage is measured against. */
  code: CodeIndex;
  /** `bin` from package.json (command → built target); names an entry point's executable. */
  bin?: Record<string, string>;
  /** Canonical doc language; selects the locale bundle. */
  language?: string;
}

interface DomainEntry {
  docPath: string;
  section: DocStateSection;
}

/**
 * The top-level page: what the system is, where execution starts, and where to look
 * for the thing that does X. Nothing is generated here — every sentence already sits
 * in a doc state, and the page only gathers the tier that is spread over one doc per
 * subsystem into a single read.
 *
 * It links names instead of only naming them (the usual advice for a hand-written
 * ARCHITECTURE.md is the opposite, because hand-written links rot): this page is
 * rewritten from state on every run, so a link cannot outlive its target.
 */
export function renderArchitecture(input: ArchitectureInput): string {
  const locale = localeBundle(input.language);
  const labels = locale.architecture;
  const project = tierSection(input.states, PROJECT_ID);
  const domains = collectDomains(input.states);
  const docByFile = docPathByFile(input.states);

  const lines: string[] = [`# ${labels.title}`, "", `> ${labels.generatedNote}`];
  pushSection(lines, labels.birdsEyeView, prose(project, ["purpose", "responsibility", "workflows"]));
  pushSection(lines, labels.boundaries, prose(project, ["limitations"]));
  pushSection(lines, labels.entryPoints, entryPoints(input, docByFile));
  pushSection(lines, labels.codeMap, codeMap(domains, docByFile, labels));
  pushSection(lines, labels.coverage, coverage(input.code, mappedFiles(domains), labels));
  return `${lines.join("\n").trimEnd()}\n`;
}

function pushSection(lines: string[], heading: string, body: string[]): void {
  if (body.length === 0) {
    return;
  }
  lines.push("", `## ${heading}`, "", ...body);
}

/** The single section of the states that owns `idPrefix` (the project tier has exactly one). */
function tierSection(states: readonly DocState[], idPrefix: string): DocStateSection | undefined {
  for (const state of states) {
    for (const sectionId of state.sectionOrder) {
      const section = state.sections[sectionId];
      if (section?.owns.some((id) => id.startsWith(idPrefix))) {
        return section;
      }
    }
  }
  return undefined;
}

function collectDomains(states: readonly DocState[]): Map<string, DomainEntry> {
  const domains = new Map<string, DomainEntry>();
  for (const state of states) {
    for (const sectionId of state.sectionOrder) {
      const section = state.sections[sectionId];
      const id = section?.owns.find((owned) => owned.startsWith(DOMAIN_ID));
      if (section && id) {
        domains.set(id, { docPath: state.docPath, section });
      }
    }
  }
  return domains;
}

/** Source file → the doc documenting it, from what each section says it owns. */
function docPathByFile(states: readonly DocState[]): Map<string, string> {
  const byFile = new Map<string, string>();
  for (const state of states) {
    for (const section of Object.values(state.sections)) {
      for (const owned of section.owns) {
        const path = sourceFileOf(owned);
        if (path && !byFile.has(path)) {
          byFile.set(path, state.docPath);
        }
      }
    }
  }
  return byFile;
}

function sourceFileOf(entityId: string): string | undefined {
  if (entityId.startsWith(FILE_ID)) {
    return entityId.slice(FILE_ID.length);
  }
  if (entityId.startsWith(SYMBOL_ID)) {
    const hash = entityId.indexOf("#");
    return hash > 0 ? entityId.slice(SYMBOL_ID.length, hash) : entityId.slice(SYMBOL_ID.length);
  }
  return undefined;
}

/**
 * A block's prose, or undefined when it should not be read here: an unrendered block
 * was filtered by score, and a stale one is withheld from its own page too — copying
 * it onto this one would hand the reader a claim the system has already disowned.
 */
function blockBody(section: DocStateSection | undefined, blockId: BlockId): string | undefined {
  const block = section?.blocks[blockId];
  if (!block || !block.rendered || block.staleSince) {
    return undefined;
  }
  const body = block.body.trim();
  return body.length > 0 ? body : undefined;
}

function prose(section: DocStateSection | undefined, blockIds: BlockId[]): string[] {
  const bodies = blockIds.map((blockId) => blockBody(section, blockId)).filter((body): body is string => !!body);
  return bodies.length > 0 ? [bodies.join("\n\n")] : [];
}

function entryPoints(input: ArchitectureInput, docByFile: ReadonlyMap<string, string>): string[] {
  const paths = [
    ...new Set(
      Object.values(input.code.entities)
        .filter((entity) => entity.metadata?.isEntryPoint)
        .map((entity) => entity.path)
    ),
  ].sort();
  return paths.map((path) => {
    const command = commandFor(path, input.bin);
    return `- ${fileLink(path, docByFile)}${command ? ` — \`${command}\`` : ""}`;
  });
}

/**
 * The command an entry point ships as. `bin` names the built artifact, the index
 * names the source, so they meet only at the file name; when two bin entries share
 * it the match is ambiguous and the page says nothing rather than pick one.
 */
function commandFor(path: string, bin: Record<string, string> | undefined): string | undefined {
  if (!bin) {
    return undefined;
  }
  const stem = fileStem(path);
  const matches = Object.entries(bin).filter(([, target]) => fileStem(target) === stem);
  return matches.length === 1 ? matches[0][0] : undefined;
}

function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The subsystems, ordered so that a subsystem appears after everything it stands on:
 * the layer ladder first, then an entry per subsystem with its members. The ladder is
 * the dependency waves of the subsystem graph — the one view of 27 subsystems and 75
 * edges that stays readable, where a single picture of the same graph would not.
 */
function codeMap(
  domains: ReadonlyMap<string, DomainEntry>,
  docByFile: ReadonlyMap<string, string>,
  labels: ArchitectureLabels
): string[] {
  if (domains.size === 0) {
    return [];
  }
  const waves = layers(domains);
  const lines: string[] = [labels.layers];
  waves.forEach((wave, level) => {
    // Names, not links: the ladder is here to be read in one glance, and every name
    // below it is a link anyway.
    const names = wave.map((id) => domainName(id, domains)).join(" · ");
    lines.push(`${level + 1}. ${names}`);
  });

  for (const id of waves.flat()) {
    const entry = domains.get(id);
    if (!entry) {
      continue;
    }
    lines.push("", `### ${domainLink(id, domains)}`);
    const description = blockBody(entry.section, "responsibility") ?? blockBody(entry.section, "purpose");
    if (description) {
      lines.push("", firstParagraph(description));
    }
    const members = entry.section.depends
      .filter((dep) => dep.startsWith(FILE_ID))
      .map((dep) => fileLink(dep.slice(FILE_ID.length), docByFile));
    if (members.length > 0) {
      lines.push("", members.join(" · "));
    }
  }
  return lines;
}

/** Subsystems grouped into dependency waves: wave 0 stands on nothing in the project. */
function layers(domains: ReadonlyMap<string, DomainEntry>): string[][] {
  const graph: DepGraph = new Map();
  for (const [id, entry] of domains) {
    graph.set(id, new Set(entry.section.depends.filter((dep) => dep.startsWith(DOMAIN_ID))));
  }
  const waves = dependencyWaves(graph, new Set(domains.keys()));
  return waves.map((wave) =>
    wave.flat().sort((left, right) => domainName(left, domains).localeCompare(domainName(right, domains)))
  );
}

function domainName(id: string, domains: ReadonlyMap<string, DomainEntry>): string {
  return domains.get(id)?.section.heading ?? id.slice(DOMAIN_ID.length);
}

function domainLink(id: string, domains: ReadonlyMap<string, DomainEntry>): string {
  const entry = domains.get(id);
  const name = domainName(id, domains);
  return entry ? `[${name}](${href(entry.docPath, entry.section.anchor)})` : name;
}

function fileLink(path: string, docByFile: ReadonlyMap<string, string>): string {
  const docPath = docByFile.get(path);
  return docPath ? `[\`${path}\`](${href(docPath)})` : `\`${path}\``;
}

/** Encode the path, leave the anchor raw so non-ascii headings read cleanly and still resolve. */
function href(docPath: string, anchor?: string): string {
  const relative = posix.relative(posix.dirname(ARCHITECTURE_DOC_PATH), docPath);
  return `${encodeURI(relative)}${anchor === undefined ? "" : `#${anchor}`}`;
}

function firstParagraph(body: string): string {
  return body.split(/\n{2,}/)[0].trim();
}

/**
 * How much of the code the map above covers, and which files it leaves out. A file
 * without a doc is a choice, not a defect — the number is here so the map cannot
 * quietly pass itself off as the whole project.
 */
function coverage(code: CodeIndex, mapped: ReadonlySet<string>, labels: ArchitectureLabels): string[] {
  const files = Object.keys(code.fileToEntities).sort();
  if (files.length === 0) {
    return [];
  }
  const outside = files.filter((file) => !mapped.has(file));
  const lines = [
    fill(labels.coverageLine, { documented: String(files.length - outside.length), total: String(files.length) }),
  ];
  if (outside.length > 0) {
    lines.push("", labels.undocumented, ...outside.map((file) => `- \`${file}\``));
  }
  return lines;
}

/** The source files the code map names — what the coverage line counts. */
function mappedFiles(domains: ReadonlyMap<string, DomainEntry>): Set<string> {
  const files = new Set<string>();
  for (const entry of domains.values()) {
    for (const dep of entry.section.depends) {
      if (dep.startsWith(FILE_ID)) {
        files.add(dep.slice(FILE_ID.length));
      }
    }
  }
  return files;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/{(\w+)}/g, (_, key) => values[key] ?? "");
}

type ArchitectureLabels = ReturnType<typeof localeBundle>["architecture"];
