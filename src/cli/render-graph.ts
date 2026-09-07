import { buildFileDag, generationWaves } from "../graph/file-dag.js";
import type { DocSection, ProjectIndex } from "../types.js";

export interface GraphRenderInput {
  index: ProjectIndex;
  /** Limit output to files under these path prefixes (their deps stay visible). */
  paths?: string[];
}

interface FileNode {
  file: string;
  wave: number;
  deps: string[];
  sections: number;
  staleSections: number;
  /** block-inclusion found page-worthy entities; false = no pages by design (types, constants, entry stubs). */
  documentable: boolean;
}

export function renderGraphTree(input: GraphRenderInput): string {
  const nodes = collectNodes(input);
  const byWave = new Map<number, FileNode[]>();
  for (const node of nodes.values()) {
    const bucket = byWave.get(node.wave) ?? [];
    bucket.push(node);
    byWave.set(node.wave, bucket);
  }

  const lines: string[] = ["Generation pyramid (dependencies first; docs of lower waves feed upper waves):", ""];
  for (const wave of [...byWave.keys()].sort((left, right) => left - right)) {
    lines.push(`wave ${wave}`);
    for (const node of (byWave.get(wave) ?? []).sort((left, right) => left.file.localeCompare(right.file))) {
      lines.push(`  ${statusMark(node)} ${node.file}${sectionsLabel(node)}`);
      for (const dep of node.deps) {
        const depNode = nodes.get(dep);
        lines.push(`      ← ${depNode ? statusMark(depNode) : "·"} ${dep}`);
      }
    }
  }
  lines.push("", "✓ documented   ~ has stale blocks   ! docs pending   ∅ no pages by design (types/constants/entry)");
  return `${lines.join("\n")}\n`;
}

/** Self-contained Cytoscape.js page: pyramid layout, click-to-highlight, doc status colors. */
export function renderGraphHtml(input: GraphRenderInput): string {
  const nodes = [...collectNodes(input).values()];
  const byWave = new Map<number, FileNode[]>();
  for (const node of nodes) {
    const bucket = byWave.get(node.wave) ?? [];
    bucket.push(node);
    byWave.set(node.wave, bucket);
  }
  const maxWave = Math.max(0, ...byWave.keys());

  const cyNodes = nodes.map((node) => {
    const rowMates = (byWave.get(node.wave) ?? []).sort((left, right) => left.file.localeCompare(right.file));
    const column = rowMates.findIndex((mate) => mate.file === node.file);
    return {
      data: {
        id: node.file,
        label: node.file.split("/").at(-1) ?? node.file,
        file: node.file,
        wave: node.wave,
        sections: node.sections,
        staleSections: node.staleSections,
        status: statusClass(node),
      },
      position: {
        x: (column - (rowMates.length - 1) / 2) * 230,
        y: (maxWave - node.wave) * 170,
      },
    };
  });
  const cyEdges = nodes.flatMap((node) =>
    node.deps.map((dep) => ({ data: { id: `${node.file}->${dep}`, source: node.file, target: dep } }))
  );

  const payload = JSON.stringify({ nodes: cyNodes, edges: cyEdges }).replace(/<\//g, "<\\/");
  return htmlPage(payload);
}

function htmlPage(payload: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>codelore graph</title>
<script src="https://unpkg.com/cytoscape@3.30.4/dist/cytoscape.min.js"></script>
<style>
  html, body, #cy { height: 100%; margin: 0; background: #fafafa; font-family: ui-monospace, monospace; }
  #legend { position: fixed; top: 12px; left: 12px; z-index: 10; background: #fff; border: 1px solid #ddd;
            border-radius: 6px; padding: 8px 12px; font-size: 12px; line-height: 1.8; }
  #legend span { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px;
                 vertical-align: middle; border: 1px solid #999; }
  #info { position: fixed; bottom: 12px; left: 12px; right: 12px; z-index: 10; background: #fff;
          border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; font-size: 12px; display: none; }
</style>
</head>
<body>
<div id="legend">
  <div><span style="background:#d3f9d8"></span>documented</div>
  <div><span style="background:#fff3bf"></span>has stale blocks</div>
  <div><span style="background:#ffe3e3"></span>docs pending (run generate)</div>
  <div><span style="background:#f8f9fa;border-style:dashed"></span>no pages by design (types, constants, entry stubs)</div>
  <div>edge: file → dependency (its docs feed the file's generation)</div>
</div>
<div id="info"></div>
<div id="cy"></div>
<script>
const data = ${payload};
const colors = { documented: "#d3f9d8", stale: "#fff3bf", pending: "#ffe3e3", excluded: "#f8f9fa" };
const borders = { documented: "#2b8a3e", stale: "#e67700", pending: "#c92a2a", excluded: "#adb5bd" };
const cy = cytoscape({
  container: document.getElementById("cy"),
  elements: [...data.nodes, ...data.edges],
  layout: { name: "preset", fit: true, padding: 50 },
  style: [
    { selector: "node", style: {
        label: "data(label)", "text-valign": "center", "font-size": 11, "font-family": "ui-monospace, monospace",
        width: "label", height: 28, padding: "8px", shape: "round-rectangle",
        "background-color": (el) => colors[el.data("status")],
        "border-color": (el) => borders[el.data("status")],
        "border-width": 1.5 } },
    { selector: 'node[status = "excluded"]', style: { "border-style": "dashed", opacity: 0.7 } },
    { selector: "edge", style: {
        width: 1.5, "line-color": "#bbb", "target-arrow-color": "#bbb",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.9 } },
    { selector: ".dim", style: { opacity: 0.15 } },
    { selector: ".focus", style: { "border-width": 3 } }
  ]
});
const info = document.getElementById("info");
cy.on("tap", "node", (event) => {
  const node = event.target;
  const related = node.closedNeighborhood();
  cy.elements().addClass("dim");
  related.removeClass("dim");
  node.addClass("focus");
  const d = node.data();
  const statusNote = {
    documented: "documented",
    stale: "has stale blocks — run fix-stale",
    pending: "docs pending — run generate",
    excluded: "no page-worthy entities (types/constants/entry stub); intentionally undocumented",
  }[d.status];
  info.style.display = "block";
  info.textContent = d.file + " — wave " + d.wave + ", sections: " + d.sections +
    (d.staleSections ? " (" + d.staleSections + " stale)" : "") +
    " | " + statusNote +
    " | deps: " + node.outgoers("node").length + " | dependents: " + node.incomers("node").length;
});
cy.on("tap", (event) => {
  if (event.target === cy) {
    cy.elements().removeClass("dim").removeClass("focus");
    info.style.display = "none";
  }
});
</script>
</body>
</html>
`;
}

function collectNodes(input: GraphRenderInput): Map<string, FileNode> {
  const { index } = input;
  const dag = buildFileDag(index.code);
  const allFiles = [...dag.keys()];
  const inScope = (file: string): boolean =>
    !input.paths ||
    input.paths.length === 0 ||
    input.paths.some((prefix) => file === prefix || file.startsWith(`${prefix.replace(/\/$/, "")}/`));

  const scoped = allFiles.filter(inScope);
  // Deps of scoped files stay visible even when outside the scope.
  const visible = new Set(scoped);
  for (const file of scoped) {
    for (const dep of dag.get(file) ?? []) {
      visible.add(dep);
    }
  }

  const waves = generationWaves(index.code, [...visible]);
  const waveOf = new Map<string, number>();
  waves.forEach((wave, level) => {
    for (const group of wave) {
      for (const file of group) {
        waveOf.set(file, level);
      }
    }
  });

  const sectionsByFile = sectionsBySourceFile(index);
  const nodes = new Map<string, FileNode>();
  for (const file of visible) {
    const sections = sectionsByFile.get(file) ?? [];
    nodes.set(file, {
      file,
      wave: waveOf.get(file) ?? 0,
      deps: [...(dag.get(file) ?? [])].filter((dep) => visible.has(dep)).sort(),
      sections: sections.length,
      staleSections: sections.filter(hasStaleBlocks).length,
      documentable: isDocumentable(file, index),
    });
  }
  return nodes;
}

/** Mirrors the prepare-phase shouldCreatePage decision at file granularity. */
function isDocumentable(file: string, index: ProjectIndex): boolean {
  return (index.code.fileToEntities[file] ?? []).some((id) => {
    const entity = index.code.entities[id];
    if (!entity) {
      return false;
    }
    return (
      entity.metadata === undefined || entity.metadata.role === "short_page" || entity.metadata.role === "full_page"
    );
  });
}

function sectionsBySourceFile(index: ProjectIndex): Map<string, DocSection[]> {
  const byFile = new Map<string, DocSection[]>();
  for (const section of Object.values(index.docs.sections)) {
    const ownerId = section.owns[0];
    const path = ownerId ? index.code.entities[ownerId]?.path : undefined;
    if (!path) {
      continue;
    }
    const bucket = byFile.get(path) ?? [];
    bucket.push(section);
    byFile.set(path, bucket);
  }
  return byFile;
}

function hasStaleBlocks(section: DocSection): boolean {
  return section.blocks.some((block) => block.staleSince !== undefined);
}

function statusMark(node: FileNode): string {
  if (node.sections === 0) {
    return node.documentable ? "!" : "∅";
  }
  return node.staleSections > 0 ? "~" : "✓";
}

function statusClass(node: FileNode): string {
  if (node.sections === 0) {
    return node.documentable ? "pending" : "excluded";
  }
  return node.staleSections > 0 ? "stale" : "documented";
}

function sectionsLabel(node: FileNode): string {
  if (node.sections === 0) {
    return "";
  }
  const stale = node.staleSections > 0 ? `, ${node.staleSections} stale` : "";
  return ` (${node.sections} section${node.sections === 1 ? "" : "s"}${stale})`;
}
