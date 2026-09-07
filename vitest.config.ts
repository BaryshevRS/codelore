import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites build a full ts-morph index or spawn the MCP server subprocess.
    // Under the default 5s timeout these tip over when many heavy files run in
    // parallel on a busy machine; the work itself takes a few seconds, not minutes.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
