import { createRequire } from "node:module";
import {
  type CallToolResult,
  McpServer,
  type ReadResourceResult,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { toCodeloreErrorPayload } from "../errors.js";
import { CodeloreService, type GenerateDocsRuntime } from "../service/codelore-service.js";
import { decodeResourceId, encodeResourceId } from "../utils/path.js";

/** The version reported in the MCP handshake comes from the manifest, so there is no second number to keep in sync. */
const { version: packageVersion } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export async function createCodeloreServer(options: { rootDir: string }): Promise<McpServer> {
  const service = new CodeloreService(options.rootDir);
  const baseInstructions =
    "Codelore stores documentation in per-doc JSON state under .codelore/state/. The .codelore.md files are rendered artifacts and must not be edited by hand. Use document to create or fill documentation for paths/files/entityIds. Use update after code changes to refresh stale documentation with LLM generation. Use mark_stale to mark drifted docs without generation. Use check to validate saved documentation without generating text. The server runs the full LLM pipeline (context assembly → block generation → validation → repair → verification → write) on its own; do not compose lower-level rewrite steps.";
  const server = new McpServer(
    {
      name: "codelore",
      version: packageVersion,
    },
    {
      instructions: baseInstructions,
    }
  );

  registerResources(server, service);
  registerTools(server, service);

  return server;
}

function registerResources(server: McpServer, service: CodeloreService): void {
  server.registerResource(
    "doc-section",
    new ResourceTemplate("doc://section/{sectionId}", {
      list: async () => {
        const index = await service.loadOrRebuildIndexes();
        return {
          resources: Object.values(index.docs.sections).map((section) => ({
            uri: `doc://section/${encodeResourceId(section.id)}`,
            name: section.id,
            title: section.heading,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    {
      title: "Documentation Section",
      description: "Markdown rendered from JSON state for a section.",
      mimeType: "text/markdown",
    },
    async (uri, variables): Promise<ReadResourceResult> =>
      readResourceSafely(uri.href, async () => {
        const sectionId = decodeResourceId(String(variables.sectionId));
        return textResource(uri.href, await service.readDocSection(sectionId), "text/markdown");
      })
  );

  server.registerResource(
    "code-entity",
    new ResourceTemplate("code://entity/{entityId}", {
      list: async () => {
        const index = await service.loadOrRebuildIndexes();
        return {
          resources: Object.values(index.code.entities).map((entity) => ({
            uri: `code://entity/${encodeResourceId(entity.id)}`,
            name: entity.id,
            title: entity.signature,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Code Entity",
      description: "Indexed code entity metadata and concise source snippet.",
      mimeType: "application/json",
    },
    async (uri, variables): Promise<ReadResourceResult> =>
      readResourceSafely(uri.href, async () => {
        const entityId = decodeResourceId(String(variables.entityId));
        return jsonResource(uri.href, await service.readCodeEntity(entityId));
      })
  );

  server.registerResource(
    "impact-graph",
    new ResourceTemplate("graph://impact/{entityId}", { list: undefined }),
    {
      title: "Impact Graph",
      description: "Dependent entities and sections for an indexed code entity.",
      mimeType: "application/json",
    },
    async (uri, variables): Promise<ReadResourceResult> =>
      readResourceSafely(uri.href, async () => {
        const entityId = decodeResourceId(String(variables.entityId));
        return jsonResource(uri.href, await service.readImpact(entityId));
      })
  );

  server.registerResource(
    "change-analysis",
    new ResourceTemplate("change://{changeId}", { list: undefined }),
    {
      title: "Change Analysis",
      description: "Saved result of a change analysis.",
      mimeType: "application/json",
    },
    async (uri, variables): Promise<ReadResourceResult> =>
      readResourceSafely(uri.href, async () => {
        const changeId = decodeResourceId(String(variables.changeId));
        return jsonResource(uri.href, await service.readChange(changeId));
      })
  );

  server.registerResource(
    "doc-file",
    new ResourceTemplate("doc://file/{docPath}", {
      list: async () => {
        const index = await service.loadOrRebuildIndexes();
        const renderedDocPaths = Object.entries(index.docs.fileToSections)
          .filter(([, sectionIds]) =>
            sectionIds.some((sectionId) => index.docs.sections[sectionId]?.blocks.some((block) => block.rendered))
          )
          .map(([docPath]) => docPath);
        return {
          resources: renderedDocPaths.map((docPath) => ({
            uri: `doc://file/${encodeResourceId(docPath)}`,
            name: docPath,
            title: docPath,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    {
      title: "Documentation File",
      description: "Full Markdown document containing documentation sections.",
      mimeType: "text/markdown",
    },
    async (uri, variables): Promise<ReadResourceResult> =>
      readResourceSafely(uri.href, async () => {
        const docPath = decodeResourceId(String(variables.docPath));
        return textResource(uri.href, await service.readDocFile(docPath), "text/markdown");
      })
  );
}

function registerTools(server: McpServer, service: CodeloreService): void {
  const generateRuntime = (command: string): GenerateDocsRuntime => ({
    env: process.env,
    fetch,
    command,
  });

  server.registerTool(
    "document",
    {
      title: "Document Code",
      description:
        "Create or update documentation for a scope. Scope is any combination of paths, files, or entityIds; omit all to document the project. Runs the full LLM pipeline and writes JSON state plus rendered Markdown.",
      inputSchema: z.object({
        paths: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        entityIds: z.array(z.string()).optional(),
        intent: z.string().optional(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
      },
    },
    async (input) => safely(() => service.generateDocsForScope(input, generateRuntime("document")))
  );

  server.registerTool(
    "update",
    {
      title: "Update Stale Documentation",
      description:
        "Refresh existing documentation after code changes. Scope by paths, files, or sectionIds; omit all to update every stale block. Tombstones drifted blocks, re-runs the LLM pipeline, and writes refreshed docs.",
      inputSchema: z.object({
        paths: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        sectionIds: z.array(z.string()).optional(),
        intent: z.string().optional(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
      },
    },
    async (input) => safely(() => service.fixStaleDocs(input, generateRuntime("update")))
  );

  server.registerTool(
    "mark_stale",
    {
      title: "Mark Stale Documentation",
      description:
        "Mark documentation blocks whose code facets drifted without calling the LLM. Scope by paths, files, or sectionIds; omit all to mark every drifted block.",
      inputSchema: z.object({
        paths: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        sectionIds: z.array(z.string()).optional(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        readOnlyHint: false,
      },
    },
    async (input) =>
      safely(() =>
        service.refreshStaleDocs({
          mode: "tombstone",
          scope: {
            paths: input.paths,
            files: input.files,
            sectionIds: input.sectionIds,
          },
        })
      )
  );

  server.registerTool(
    "check",
    {
      title: "Check Documentation",
      description:
        "Validate saved documentation without generating text. Reports broken metadata links, stale blocks, empty/TODO blocks, and optional quality findings. Walk findings one at a time: for a stale block run update scoped to that section; for a removed code entity or an ambiguous issue report that section for manual review. Do not bulk-rewrite.",
      inputSchema: z.object({
        quality: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (input) => safely(() => service.validateDocs({ includeQuality: input.quality }))
  );
}

async function safely<T>(handler: () => Promise<T>): Promise<CallToolResult> {
  try {
    return jsonToolResult(await handler());
  } catch (error) {
    return jsonToolError(error);
  }
}

function jsonToolResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: summarizeToolResult(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function jsonToolError(error: unknown): CallToolResult {
  const payload = {
    ok: false,
    error: toCodeloreErrorPayload(error),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function summarizeToolResult(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return JSON.stringify({ ok: true });
  }

  const record = data as Record<string, unknown>;
  const summary: Record<string, unknown> = { ok: true };

  copyIfPresent(record, summary, "id");
  copyIfPresent(record, summary, "sectionId");
  copyIfPresent(record, summary, "docPath");
  copyIfPresent(record, summary, "generatedAt");
  copyIfPresent(record, summary, "codeEntities");
  copyIfPresent(record, summary, "codeFiles");
  copyIfPresent(record, summary, "docSections");
  copyIfPresent(record, summary, "docFiles");
  copyIfPresent(record, summary, "dryRun");
  copyIfPresent(record, summary, "nextAction");
  copyIfPresent(record, summary, "guidance");
  copyIfPresent(record, summary, "summary");

  for (const key of [
    "changedFiles",
    "changedEntities",
    "affectedSections",
    "plannedSections",
    "createdSections",
    "skippedSections",
    "updatedSections",
    "updatedBlocks",
    "issues",
    "failed",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) {
      summary[key] = value.length;
    }
  }

  return JSON.stringify(summary);
}

function copyIfPresent(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

async function readResourceSafely(
  uri: string,
  handler: () => Promise<ReadResourceResult>
): Promise<ReadResourceResult> {
  try {
    return await handler();
  } catch (error) {
    return jsonResource(uri, {
      ok: false,
      error: toCodeloreErrorPayload(error),
    });
  }
}

function textResource(uri: string, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [{ uri, mimeType, text }],
  };
}

function jsonResource(uri: string, data: unknown): ReadResourceResult {
  return textResource(uri, JSON.stringify(data, null, 2), "application/json");
}
