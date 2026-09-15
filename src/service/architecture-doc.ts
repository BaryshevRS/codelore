import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARCHITECTURE_DOC_PATH, renderArchitecture } from "../markdown/render-architecture.js";
import type { DocStateStorage } from "../storage/doc-state-storage.js";
import type { CodeIndex, CodeloreConfig, DocState } from "../types.js";

/**
 * Renders the top-level ARCHITECTURE page from every doc state and writes it next to
 * the code. Skipped while the project has no subsystem tier: the map is a map of
 * subsystems, and without them the page would be headings over nothing.
 */
export async function writeArchitectureDoc(
  config: CodeloreConfig,
  storage: DocStateStorage,
  code: CodeIndex
): Promise<void> {
  const states: DocState[] = [];
  for (const docPath of await storage.listDocStates()) {
    const state = await storage.loadDocState(docPath);
    if (state) {
      states.push(state);
    }
  }
  const hasSubsystems = states.some((state) =>
    Object.values(state.sections).some((section) => section.owns.some((id) => id.startsWith("domain:")))
  );
  if (!hasSubsystems) {
    return;
  }
  const markdown = renderArchitecture({
    states,
    code,
    bin: await readBin(config.rootDir),
    language: config.docs.language,
  });
  await storage.writeGeneratedPage(ARCHITECTURE_DOC_PATH, markdown);
}

/**
 * The `bin` map of the project's package.json, normalized to command → target.
 * npm allows a bare string there, meaning one command named after the package.
 * A project without a package.json (or without `bin`) simply has no command names.
 */
async function readBin(rootDir: string): Promise<Record<string, string> | undefined> {
  let manifest: { name?: string; bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof manifest.bin === "string") {
    const name = manifest.name?.split("/").at(-1);
    return name ? { [name]: manifest.bin } : undefined;
  }
  return manifest.bin;
}
