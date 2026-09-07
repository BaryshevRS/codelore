import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { dirname, normalize } from "node:path/posix";
import type { Heading, Root } from "mdast";

export interface TransformDocumentInput {
  docPath: string;
  markdown: string;
  routeByDocPath: ReadonlyMap<string, string>;
}

export function transformDocument(input: TransformDocumentInput): string {
  const tree = fromMarkdown(input.markdown);
  const title = extractTitle(tree, input.docPath);
  rewriteLinks(tree, input);
  demoteAdditionalTopLevelHeadings(tree);

  return `---\ntitle: ${yamlScalar(title)}\n---\n\n${toMarkdown(tree)}`;
}

function extractTitle(tree: Root, docPath: string): string {
  const titleIndex = tree.children.findIndex((node) => node.type === "heading" && node.depth === 1);
  if (titleIndex === -1) {
    throw new Error(`Codelore document "${docPath}" must start with an H1 title`);
  }

  const title = toString(tree.children[titleIndex]);
  tree.children.splice(titleIndex, 1);
  return title;
}

function demoteAdditionalTopLevelHeadings(tree: Root): void {
  let sectionDepthOffset = 0;
  for (const node of tree.children) {
    if (node.type !== "heading") {
      continue;
    }

    if (node.depth === 1) {
      node.depth = 2;
      sectionDepthOffset = 1;
      continue;
    }

    if (sectionDepthOffset === 1) {
      node.depth = Math.min(node.depth + 1, 6) as Heading["depth"];
    }
  }
}

function rewriteLinks(tree: Root, input: TransformDocumentInput): void {
  visit(tree, "link", (node) => {
    const [path, hash = ""] = node.url.split("#", 2);
    if (!path.endsWith(".codelore.md") || isAbsoluteUrl(path)) {
      return;
    }

    const targetDocPath = normalize(dirname(input.docPath) + "/" + path);
    const targetRoute = input.routeByDocPath.get(targetDocPath);
    if (!targetRoute) {
      throw new Error(`Unknown Codelore document "${targetDocPath}" linked from "${input.docPath}"`);
    }

    node.url = hash ? `${targetRoute}#${hash}` : targetRoute;
  });
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("#");
}

function yamlScalar(value: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N} .,'’_-]*$/u.test(value) ? value : JSON.stringify(value);
}
