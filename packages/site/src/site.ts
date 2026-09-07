import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { create } from "create-fumadocs-app";
import { syncSite, type SyncSiteResult } from "./sync.js";

const CONFIG_VERSION = 1;

export interface CreateSiteInput {
  rootDir: string;
  outputDir: string;
}

export async function createSite(input: CreateSiteInput): Promise<SyncSiteResult> {
  await create({
    outputDir: input.outputDir,
    template: "+next+fuma-docs-mdx",
    packageManager: "pnpm",
  });

  await rm(join(input.outputDir, "content", "docs"), { force: true, recursive: true });
  const summary = await syncSite(input);
  await mkdir(join(input.outputDir, ".codelore-site"), { recursive: true });
  await writeFile(
    join(input.outputDir, ".codelore-site", "config.json"),
    `${JSON.stringify(
      {
        version: CONFIG_VERSION,
        rootDir: relative(input.outputDir, input.rootDir).split(sep).join("/") || ".",
        contentDir: "content/docs",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return summary;
}
