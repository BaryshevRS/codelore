import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildCodeIndex } from "../indexer/code-indexer.js";
import { buildRuntimeContext } from "./runtime-context-builder.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("buildRuntimeContext", () => {
  it("finds enclosing listener via ripgrep + AST for emitter literal", async () => {
    const dir = await makeProject({
      "src/emitter.ts": ["export function emitWelcome() {", "  emit('user.registered');", "}"].join("\n"),
      "src/listener.ts": ["export function handleSignup() {", "  subscribe('user.registered', () => {});", "}"].join(
        "\n"
      ),
    });

    const codeIndex = await buildCodeIndex(loadConfig(dir));
    const result = await buildRuntimeContext({
      targetEntityId: "symbol:src/emitter.ts#emitWelcome",
      codeIndex,
      rootDir: dir,
    });

    expect(result.unresolvedLiterals).toEqual([]);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      entityId: "symbol:src/listener.ts#handleSignup",
      literalValue: "user.registered",
      syntaxRole: "CallExpression.arguments[0]",
    });
  });

  it("resolves a module-level callsite to the file-level entity id", async () => {
    const dir = await makeProject({
      "src/emitter.ts": ["export function emitWelcome() {", "  emit('topic.alpha');", "}"].join("\n"),
      "src/bootstrap.ts": ["subscribe('topic.alpha', () => {});", ""].join("\n"),
    });

    const codeIndex = await buildCodeIndex(loadConfig(dir));
    const result = await buildRuntimeContext({
      targetEntityId: "symbol:src/emitter.ts#emitWelcome",
      codeIndex,
      rootDir: dir,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.entityId).toBe("file:src/bootstrap.ts");
    expect(codeIndex.entities[result.hits[0]?.entityId ?? ""]).toBeDefined();
  });

  it("marks literal as unresolved when no other file references it", async () => {
    const dir = await makeProject({
      "src/lonely.ts": ["export function emitAlone() {", "  emit('never-listened-event');", "}"].join("\n"),
    });

    const codeIndex = await buildCodeIndex(loadConfig(dir));
    const result = await buildRuntimeContext({
      targetEntityId: "symbol:src/lonely.ts#emitAlone",
      codeIndex,
      rootDir: dir,
    });

    expect(result.hits).toEqual([]);
    expect(result.unresolvedLiterals).toEqual(["never-listened-event"]);
  });
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codelore-runtime-"));
  tempDirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, text, "utf8");
  }
  return root;
}
