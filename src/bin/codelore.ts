#!/usr/bin/env node
import { runCli } from "../cli/run-cli.js";
import { loadDotEnv } from "../config.js";

loadDotEnv(process.cwd());

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
