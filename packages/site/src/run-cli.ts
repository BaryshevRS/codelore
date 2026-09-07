import { resolve } from "node:path";
import { createSite, type CreateSiteInput } from "./site.js";
import { syncSite, type SyncSiteInput, type SyncSiteResult } from "./sync.js";

export interface CliRuntime {
  cwd: string;
  stdout: (value: string) => void;
  createSite: (input: CreateSiteInput) => Promise<SyncSiteResult>;
  syncSite: (input: SyncSiteInput) => Promise<SyncSiteResult>;
}

export async function runCli(argv: string[], runtime: CliRuntime): Promise<number> {
  const [command, ...args] = argv;
  const input = parseInput(command, args, runtime.cwd);
  const result = command === "init" ? await runtime.createSite(input) : await runtime.syncSite(input);
  runtime.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseInput(command: string | undefined, args: string[], cwd: string): SyncSiteInput {
  if (command !== "init" && command !== "sync") {
    throw new Error(`Unknown command "${command ?? ""}". Expected init or sync.`);
  }

  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--root" && argument !== "--output") {
      if (argument.startsWith("--")) {
        throw new Error(`Unknown option "${argument}" for ${command}.`);
      }
      throw new Error(`Unexpected positional argument "${argument}" for ${command}.`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option ${argument} is required.`);
    }
    options.set(argument, value);
    index += 1;
  }

  const rootDir = options.get("--root");
  const outputDir = options.get("--output");
  if (!rootDir) {
    throw new Error("Option --root is required.");
  }
  if (!outputDir) {
    throw new Error("Option --output is required.");
  }

  return { rootDir: resolve(cwd, rootDir), outputDir: resolve(cwd, outputDir) };
}

export const defaultCliRuntime: CliRuntime = {
  cwd: process.cwd(),
  stdout: (value) => process.stdout.write(value),
  createSite,
  syncSite,
};
