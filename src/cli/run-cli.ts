import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodeloreError, toCodeloreErrorPayload } from "../errors.js";
import { startStdioServer } from "../server/start-stdio-server.js";
import { CodeloreService, type GenerateDocsRuntime } from "../service/codelore-service.js";
import type { PrepareInitialDocsInput, RefreshStaleDocsInput, RefreshStaleMode } from "../types.js";
import { renderGraphHtml, renderGraphTree } from "./render-graph.js";

interface CliRuntime {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  fetch?: typeof fetch;
}

interface ParsedCli {
  command: string;
  args: string[];
  rootDir: string;
  provider?: string;
}

export async function runCli(argv: string[], runtime: CliRuntime): Promise<number> {
  try {
    const parsed = parseGlobalArgs(argv, runtime.cwd);
    if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
      runtime.stdout.write(helpText());
      return 0;
    }

    if (parsed.command === "mcp") {
      await startStdioServer({ rootDir: parsed.rootDir });
      return 0;
    }

    const service = new CodeloreService(parsed.rootDir);
    const result = await runCommand(service, parsed, runtime);
    if (result !== undefined) {
      runtime.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    if (isUnclean(result)) {
      return 2;
    }
    return 0;
  } catch (error) {
    runtime.stderr.write(`${JSON.stringify({ ok: false, error: toCodeloreErrorPayload(error) }, null, 2)}\n`);
    return 1;
  }
}

const VALUE_OPTIONS = new Set([
  "--path",
  "--file",
  "--entity",
  "--intent",
  "--section",
  "--mode",
  "--diff-file",
  "--reason",
]);
const FLAG_OPTIONS = new Set(["--dry-run", "--fill", "--verbose", "--quality", "--html", "--force"]);

/**
 * Every command except mark-review-needed takes options only. A stray
 * positional must be an error: "generate graph" silently degrading into a
 * repo-wide generate is an expensive typo.
 */
function assertExpectedArgs(command: string, args: string[], allowedPositionals: number): void {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(arg)) {
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CodeloreError("INTERNAL_ERROR", `Unknown option "${arg}" for command "${command}". Run codelore help.`);
    }
    positionals.push(arg);
  }
  if (positionals.length > allowedPositionals) {
    const extra = positionals.slice(allowedPositionals).join(", ");
    throw new CodeloreError(
      "INTERNAL_ERROR",
      `Unexpected argument "${extra}" for command "${command}". Run codelore help.`
    );
  }
}

async function runCommand(service: CodeloreService, parsed: ParsedCli, runtime: CliRuntime): Promise<unknown> {
  assertExpectedArgs(parsed.command, parsed.args, parsed.command === "mark-review-needed" ? 1 : 0);
  switch (parsed.command) {
    case "rebuild-index":
      return service.rebuildIndex({ verbose: hasFlag(parsed.args, "--verbose") });
    case "analyze-change":
      return service.analyzeChange(await parseAnalyzeChangeInput(parsed.args));
    case "prepare-initial-docs":
      return prepareInitialDocs(service, parsed, runtime);
    case "generate":
      return service.generateDocsForScope(
        {
          ...parseScope(parsed.args),
          intent: optionValue(parsed.args, "--intent"),
          force: hasFlag(parsed.args, "--force"),
        },
        generateRuntime(parsed, runtime, "generate")
      );
    case "fix-stale":
      return service.fixStaleDocs(
        {
          paths: optionValues(parsed.args, "--path"),
          files: optionValues(parsed.args, "--file"),
          sectionIds: optionValues(parsed.args, "--section"),
          intent: optionValue(parsed.args, "--intent"),
        },
        generateRuntime(parsed, runtime, "fix-stale")
      );
    case "refresh-stale-docs":
      return service.refreshStaleDocs(parseRefreshStaleDocsInput(parsed.args));
    case "graph": {
      const index = await service.rebuildIndexes();
      const input = { index, paths: optionValues(parsed.args, "--path") };
      if (hasFlag(parsed.args, "--html")) {
        const dir = join(parsed.rootDir, ".codelore", "render-graph");
        await mkdir(dir, { recursive: true });
        const htmlPath = join(dir, "index.html");
        await writeFile(htmlPath, renderGraphHtml(input), "utf8");
        runtime.stdout.write(`${htmlPath}\n`);
        return undefined;
      }
      runtime.stdout.write(renderGraphTree(input));
      return undefined;
    }
    case "validate-docs":
      return service.validateDocs({ includeQuality: hasFlag(parsed.args, "--quality") });
    case "mark-review-needed":
      return service.markReviewNeeded(
        requiredArg(parsed.args, 0, "sectionId"),
        requiredOption(parsed.args, "--reason")
      );
    default:
      throw new CodeloreError("INTERNAL_ERROR", `Unknown CLI command "${parsed.command}". Run codelore help.`);
  }
}

async function prepareInitialDocs(service: CodeloreService, parsed: ParsedCli, runtime: CliRuntime): Promise<unknown> {
  const input = parseScope(parsed.args);
  if (hasFlag(parsed.args, "--fill") && !input.dryRun) {
    return service.generateDocsForScope(
      { ...input, intent: optionValue(parsed.args, "--intent") },
      generateRuntime(parsed, runtime, "prepare-initial-docs --fill")
    );
  }
  return service.prepareInitialDocs(input);
}

function generateRuntime(parsed: ParsedCli, runtime: CliRuntime, command: string): GenerateDocsRuntime {
  return {
    env: runtime.env,
    fetch: runtime.fetch,
    command,
    ...(parsed.provider ? { providerName: parsed.provider } : {}),
  };
}

async function parseAnalyzeChangeInput(args: string[]): Promise<{ diff?: string; changedFiles?: string[] }> {
  const diffFile = optionValue(args, "--diff-file");
  return {
    ...(diffFile ? { diff: await readFile(diffFile, "utf8") } : {}),
    changedFiles: optionValues(args, "--file"),
  };
}

function parseScope(args: string[]): PrepareInitialDocsInput {
  return {
    paths: optionValues(args, "--path"),
    files: optionValues(args, "--file"),
    entityIds: optionValues(args, "--entity"),
    dryRun: hasFlag(args, "--dry-run"),
  };
}

function parseRefreshStaleDocsInput(args: string[]): RefreshStaleDocsInput {
  const mode = optionValue(args, "--mode") as RefreshStaleMode | undefined;
  if (mode && !["report", "rewrite_plan", "tombstone"].includes(mode)) {
    throw new CodeloreError("INTERNAL_ERROR", `Unsupported refresh mode "${mode}"`);
  }

  return {
    mode,
    scope: {
      sectionIds: optionValues(args, "--section"),
      files: optionValues(args, "--file"),
      paths: optionValues(args, "--path"),
    },
  };
}

function parseGlobalArgs(argv: string[], cwd: string): ParsedCli {
  const args = [...argv];
  const rootDir = extractOption(args, "--root") ?? cwd;
  const provider = extractOption(args, "--provider");
  const command = args.shift() ?? "help";
  return { command, args, rootDir, provider };
}

function extractOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CodeloreError("INTERNAL_ERROR", `Option ${name} requires a value`);
  }

  args.splice(index, 2);
  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  return optionValues(args, name)[0];
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) {
    throw new CodeloreError("INTERNAL_ERROR", `Option ${name} is required`);
  }
  return value;
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CodeloreError("INTERNAL_ERROR", `Option ${name} requires a value`);
    }
    values.push(value);
  }
  return values;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function requiredArg(args: string[], index: number, label: string): string {
  const value = args.filter((arg) => !arg.startsWith("--"))[index];
  if (!value) {
    throw new CodeloreError("INTERNAL_ERROR", `Missing required argument ${label}`);
  }
  return value;
}

/**
 * Exit 2 means the command itself ran fine but the project is not clean: sections the
 * pipeline could not write ("failed"), or validation findings ("issues"). Without the
 * "issues" arm `validate-docs` always exited 0 and could not gate anything in CI.
 */
function isUnclean(result: unknown): boolean {
  return nonEmptyArray(result, "failed") || nonEmptyArray(result, "issues");
}

function nonEmptyArray(result: unknown, field: string): boolean {
  if (typeof result !== "object" || result === null || !(field in result)) {
    return false;
  }
  const value = (result as Record<string, unknown>)[field];
  return Array.isArray(value) && value.length > 0;
}

function helpText(): string {
  return `codelore CLI

Usage:
  codelore [--root <dir>] [--provider <name>] <command> [options]

Commands:
  mcp                                      Start MCP stdio server
  rebuild-index [--verbose]                Rebuild code/doc indexes
  analyze-change [--file <path>] [--diff-file <path>]
  prepare-initial-docs [--path <path>] [--file <path>] [--entity <id>] [--dry-run] [--fill] [--intent <text>]
  generate [--path <path>] [--file <path>] [--entity <id>] [--intent <text>] [--force]
                                           Prepare skeletons, fill them, tombstone stale blocks, refill.
                                           --force regenerates every allowed block in scope (not just drifted),
                                           clearing a review_needed section whose blocks are all fresh.
  fix-stale [--path <path>] [--file <path>] [--section <id>] [--intent <text>]
                                           Tombstone stale blocks then refill them via the LLM pipeline
  refresh-stale-docs [--mode report|rewrite_plan|tombstone] [--section <id>] [--file <path>] [--path <path>]
  graph [--path <path>] [--html]           Show the generation pyramid: waves, deps, doc status.
                                           --html writes .codelore/render-graph/index.html (Cytoscape)
  validate-docs [--quality]
  mark-review-needed <sectionId> --reason <text>
`;
}
