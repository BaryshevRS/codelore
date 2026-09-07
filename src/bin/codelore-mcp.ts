#!/usr/bin/env node
import { runCli } from "../cli/run-cli.js";
import { loadDotEnv } from "../config.js";

loadDotEnv(process.cwd());

// MCP clients launch a bare executable with no subcommand; `mcp` is prepended so
// the server shares the CLI's single entry path (including `--root`).
process.exitCode = await runCli(["mcp", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
