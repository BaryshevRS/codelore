import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildCodeIndex } from "../indexer/code-indexer.js";
import { AstHitFilter } from "./ast-hit-filter.js";
import { resolveEnclosing } from "./enclosing-resolver.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveEnclosing", () => {
  it("attaches a literal inside a class method to the method entity id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codelore-enclosing-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    const rel = "src/handler.ts";
    const abs = join(dir, rel);
    const text = ["export class Handler {", "  run() {", "    subscribe('topic.alpha');", "  }", "}"].join("\n");
    await writeFile(abs, text, "utf8");

    const codeIndex = await buildCodeIndex(loadConfig(dir));
    const filter = new AstHitFilter();
    const callLine = text.split("\n")[2];
    const column = callLine.indexOf("'topic.alpha'") + 2;
    const hit = { file: abs, line: 3, column, matched: "topic.alpha" };
    const filtered = filter.filter(hit, "topic.alpha");
    expect(filtered).not.toBeNull();
    if (!filtered) {
      return;
    }
    const sourceFile = filter.getSourceFile(abs);
    expect(sourceFile).not.toBeNull();
    if (!sourceFile) {
      return;
    }

    const resolved = resolveEnclosing({ hit: filtered, sourceFile, codeIndex, indexFileKey: rel });
    expect(resolved?.entityId).toBe("symbol:src/handler.ts#Handler.run");
    expect(resolved?.literalValue).toBe("topic.alpha");
    expect(resolved?.syntaxRole).toBe("CallExpression.arguments[0]");
  });
});
