import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { syncSite } from "./sync.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("syncSite", () => {
  it("writes transformed docs, then removes only no-longer-generated files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codelore-site-source-"));
    const outputDir = await mkdtemp(join(tmpdir(), "codelore-site-output-"));
    temporaryDirectories.push(rootDir, outputDir);

    await mkdir(join(rootDir, ".codelore/state/src"), { recursive: true });
    await writeFile(
      join(rootDir, ".codelore/state/overview.codelore.json"),
      JSON.stringify({ docPath: "overview.codelore.md", version: 4 }),
    );
    await writeFile(
      join(rootDir, ".codelore/state/src/alpha.codelore.json"),
      JSON.stringify({ docPath: "src/alpha.codelore.md", version: 4 }),
    );
    await writeFile(
      join(rootDir, ".codelore/state/debug.codelore.generation-debug.phase.json"),
      JSON.stringify({ docPath: "debug.codelore.md", version: 4 }),
    );
    await writeFile(
      join(rootDir, "overview.codelore.md"),
      "# Overview\n\nStart here.\n",
    );
    await mkdir(join(rootDir, "src"), { recursive: true });
    await writeFile(
      join(rootDir, "src/alpha.codelore.md"),
      "# Alpha\n\nSee the [overview](../overview.codelore.md).\n",
    );

    const initialSync = await syncSite({ outputDir, rootDir });

    expect(initialSync).toEqual({
      removed: [],
      written: ["content/docs/index.md", "content/docs/src/alpha.md"],
    });
    await expect(readFile(join(outputDir, "content/docs/index.md"), "utf8")).resolves
      .toBe("---\ntitle: Overview\n---\n\nStart here.\n");
    await expect(readFile(join(outputDir, "content/docs/src/alpha.md"), "utf8")).resolves
      .toBe(
        "---\ntitle: Alpha\n---\n\nSee the [overview](/docs).\n",
      );

    await writeFile(
      join(outputDir, "content/docs/user-note.md"),
      "Keep this manual note.\n",
    );
    await rm(join(rootDir, ".codelore/state/src/alpha.codelore.json"));

    const laterSync = await syncSite({ outputDir, rootDir });

    expect(laterSync).toEqual({
      removed: ["content/docs/src/alpha.md"],
      written: ["content/docs/index.md"],
    });
    await expect(readFile(join(outputDir, "content/docs/user-note.md"), "utf8")).resolves.toBe(
      "Keep this manual note.\n",
    );
    await expect(readFile(join(outputDir, "content/docs/src/alpha.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(outputDir, ".codelore-site/content-manifest.json"), "utf8"),
    ).resolves.toContain("content/docs/index.md");
  });
});
