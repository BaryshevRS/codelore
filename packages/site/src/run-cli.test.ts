import { describe, expect, it, vi } from "vitest";

import { runCli } from "./run-cli.js";

const rootDir = "/workspace/canonical-docs";
const outputDir = "/workspace/site";

function createRuntime() {
  return {
    createSite: vi.fn(),
    cwd: "/workspace",
    stdout: vi.fn(),
    syncSite: vi.fn(),
  };
}

describe("runCli", () => {
  it("creates a site for init and writes its summary as pretty JSON", async () => {
    const runtime = createRuntime();
    const summary = { removed: [], written: ["content/docs/index.md"] };
    runtime.createSite.mockResolvedValue(summary);

    await expect(
      runCli(["init", "--root", rootDir, "--output", outputDir], runtime),
    ).resolves.toBe(0);

    expect(runtime.createSite).toHaveBeenCalledWith({ outputDir, rootDir });
    expect(runtime.syncSite).not.toHaveBeenCalled();
    expect(runtime.stdout).toHaveBeenCalledWith(`${JSON.stringify(summary, null, 2)}\n`);
  });

  it("synchronizes a site for sync and writes its summary as pretty JSON", async () => {
    const runtime = createRuntime();
    const summary = {
      removed: ["content/docs/old.md"],
      written: ["content/docs/index.md"],
    };
    runtime.syncSite.mockResolvedValue(summary);

    await expect(
      runCli(["sync", "--root", rootDir, "--output", outputDir], runtime),
    ).resolves.toBe(0);

    expect(runtime.createSite).not.toHaveBeenCalled();
    expect(runtime.syncSite).toHaveBeenCalledWith({ outputDir, rootDir });
    expect(runtime.stdout).toHaveBeenCalledWith(`${JSON.stringify(summary, null, 2)}\n`);
  });

  it("rejects a command missing a required option", async () => {
    await expect(runCli(["init", "--root", rootDir], createRuntime())).rejects.toThrow(
      /--output|required/i,
    );
  });

  it("rejects an unknown command", async () => {
    await expect(
      runCli(["publish", "--root", rootDir, "--output", outputDir], createRuntime()),
    ).rejects.toThrow(/unknown command|publish/i);
  });

  it("rejects a stray positional argument", async () => {
    await expect(
      runCli(
        ["sync", "unexpected", "--root", rootDir, "--output", outputDir],
        createRuntime(),
      ),
    ).rejects.toThrow(/positional|unexpected/i);
  });
});
