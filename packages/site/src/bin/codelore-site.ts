#!/usr/bin/env node
import { defaultCliRuntime, runCli } from "../run-cli.js";

const exitCode = await runCli(process.argv.slice(2), defaultCliRuntime).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});

process.exitCode = exitCode;
