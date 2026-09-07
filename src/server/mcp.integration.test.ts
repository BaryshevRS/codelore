import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { CodeloreService } from "../service/codelore-service.js";

const repoRoot = process.cwd();
const serverEntry = join(repoRoot, "dist/bin/codelore.js");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP integration", () => {
  it("does not expose context://project when legacy context files exist", async () => {
    const rootDir = await makeTempProject({
      "CODELORE.md": "Legacy project-wide documentation rules.\n",
      "src/pricing.ts": ["export function buildPrice(amount: number): number {", "  return amount;", "}"].join("\n"),
    });
    const { client, transport } = await connectClient(rootDir);

    try {
      const serverInstructions = client.getInstructions?.() ?? "";
      expect(serverInstructions).not.toContain("context://project");

      const resources = await client.listResources();
      const projectResource = resources.resources.find((resource) => resource.uri === "context://project");
      expect(projectResource).toBeUndefined();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("does not advertise context://project when no context files exist", async () => {
    const rootDir = await makeTempProject({
      "AGENTS.md": "Repo agent rules — handled by the host, not Codelore.\n",
      "src/pricing.ts": ["export function buildPrice(amount: number): number {", "  return amount;", "}"].join("\n"),
    });
    const { client, transport } = await connectClient(rootDir);

    try {
      const serverInstructions = client.getInstructions?.() ?? "";
      expect(serverInstructions).not.toContain("context://project");

      const resources = await client.listResources();
      const projectResource = resources.resources.find((resource) => resource.uri === "context://project");
      expect(projectResource).toBeUndefined();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("lists tools, reads resources, and returns structured tool errors", async () => {
    const rootDir = await makeTempProject({
      "src/pricing.ts": ["export function buildPrice(amount: number): number {", "  return amount;", "}"].join("\n"),
    });
    await new CodeloreService(rootDir).prepareInitialDocs();
    const { client, transport } = await connectClient(rootDir);

    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(["document", "update", "mark_stale", "check"]);
      expect(toolNames).not.toContain("rebuild_index");
      expect(toolNames).not.toContain("analyze_change");
      expect(toolNames).not.toContain("get_affected_sections");
      expect(toolNames).not.toContain("prepare_initial_docs");
      expect(toolNames).not.toContain("validate_docs");
      expect(toolNames).not.toContain("generate_docs_for_entity");
      expect(toolNames).not.toContain("generate_docs_for_scope");
      expect(toolNames).not.toContain("fix_stale_docs");
      expect(toolNames).not.toContain("refresh_stale_docs");
      expect(toolNames).not.toContain("mark_review_needed");
      expect(toolNames).not.toContain("get_section_context");
      expect(toolNames).not.toContain("rewrite_section");
      expect(toolNames).not.toContain("rewrite_sections");

      const checked = await client.callTool({
        name: "check",
        arguments: {},
      });
      expect(checked.isError).not.toBe(true);
      expect((checked.structuredContent as { issues?: unknown[] }).issues).toEqual([]);

      const marked = await client.callTool({
        name: "mark_stale",
        arguments: { files: ["src/pricing.ts"] },
      });
      expect(marked.isError).not.toBe(true);
      expect((marked.structuredContent as { appliedTombstones?: unknown[] }).appliedTombstones).toEqual([]);

      const resources = await client.listResources();
      const sectionResource = resources.resources.find((resource) => resource.uri.startsWith("doc://section/"));
      expect(sectionResource).toBeDefined();
      if (!sectionResource) {
        throw new Error("section resource not found");
      }

      const section = await client.readResource({ uri: sectionResource.uri });
      expect(section.contents[0]).toMatchObject({ mimeType: "text/markdown" });
      expect("text" in section.contents[0] ? section.contents[0].text : "").toContain("# buildPrice");

      // doc-file list must not advertise skeleton-only docs (the .md doesn't exist on disk yet).
      const docFileResource = resources.resources.find((resource) => resource.uri.startsWith("doc://file/"));
      expect(docFileResource).toBeUndefined();

      const errorResult = await client.callTool({
        name: "document",
        arguments: { entityIds: ["symbol:src/missing.ts#missing"] },
      });
      expect(errorResult.isError).toBe(true);
      const errorCode = (errorResult.structuredContent as { error?: { code?: string } }).error?.code;
      expect(["UNKNOWN_ENTITY", "UNKNOWN_SECTION"]).toContain(errorCode);
    } finally {
      await client.close();
      await transport.close();
    }
  });
});

async function connectClient(rootDir: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const client = new Client({ name: "codelore-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, "mcp"],
    cwd: rootDir,
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "codelore-mcp-"));
  tempDirs.push(rootDir);

  for (const [path, text] of Object.entries(files)) {
    const absolutePath = join(rootDir, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }

  return rootDir;
}
