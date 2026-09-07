import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());

vi.mock("create-fumadocs-app", () => ({ create }));

import { createSite } from "./site.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  create.mockReset();
});

describe("createSite", () => {
  it("creates a Fumadocs site, syncs canonical docs, and saves its configuration", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "codelore-site-"));
    const rootDir = join(workspaceDir, "canonical-root");
    const outputDir = join(workspaceDir, "generated-site");
    temporaryDirectories.push(workspaceDir);

    create.mockImplementation(async ({ outputDir: directory }: { outputDir: string }) => {
      await mkdir(join(directory, "content/docs"), { recursive: true });
    });

    await mkdir(join(rootDir, ".codelore/state"), { recursive: true });
    await writeFile(
      join(rootDir, ".codelore/state/overview.codelore.json"),
      JSON.stringify({ docPath: "overview.codelore.md", version: 4 }),
    );
    await writeFile(
      join(rootDir, "overview.codelore.md"),
      "# Overview\n\nStart here.\n",
    );

    const summary = await createSite({ outputDir, rootDir });

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      outputDir,
      packageManager: "pnpm",
      template: "+next+fuma-docs-mdx",
    });
    await expect(readFile(join(outputDir, "content/docs/index.md"), "utf8")).resolves.toBe(
      "---\ntitle: Overview\n---\n\nStart here.\n",
    );
    expect(
      JSON.parse(
        await readFile(join(outputDir, ".codelore-site/config.json"), "utf8"),
      ),
    ).toEqual({
      contentDir: "content/docs",
      rootDir: "../canonical-root",
      version: 1,
    });
    expect(summary).toEqual({
      removed: [],
      written: ["content/docs/index.md"],
    });
  });
});
