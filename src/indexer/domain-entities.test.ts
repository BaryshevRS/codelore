import { describe, expect, it } from "vitest";
import type { DomainMap } from "../domains/domain-map.js";
import type { CodeEntity, CodeIndex } from "../types.js";
import { buildDomainEntities, DOMAIN_BLOCKS, isSourceCodeEntity, PROJECT_ID } from "./domain-entities.js";

function indexFromDeps(deps: Record<string, string[]>): CodeIndex {
  const entities: Record<string, CodeEntity> = {};
  const fileToEntities: Record<string, string[]> = {};
  for (const [file, dependsOn] of Object.entries(deps)) {
    const fileId = `file:${file}`;
    const fnId = `symbol:${file}#fn`;
    entities[fileId] = mkEntity(fileId, "file", file, file);
    entities[fnId] = { ...mkEntity(fnId, "function", file, "fn"), directDeps: dependsOn.map((d) => `symbol:${d}#fn`) };
    fileToEntities[file] = [fileId, fnId];
  }
  return { version: 1, generatedAt: "", rootDir: "/r", entities, fileToEntities };
}

function mkEntity(id: string, type: CodeEntity["type"], path: string, name: string): CodeEntity {
  return {
    id,
    type,
    path,
    name,
    signature: "",
    range: { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 },
    directDeps: [],
    directUsages: [],
    contentHash: "h",
    facets: { signature: "s", body: "b", deps: "d", usage: "u", placement: "p" },
  };
}

function mapOf(domains: Array<{ slug: string; files: string[] }>): DomainMap {
  return { version: 1, generatedAt: "", domains: domains.map((d) => ({ ...d, name: d.slug })) };
}

describe("buildDomainEntities", () => {
  // Membership cuts across directories: writer+svc = "generation", dag = "graph".
  const code = indexFromDeps({
    "src/service/svc.ts": ["src/llm/writer.ts"],
    "src/llm/writer.ts": ["src/graph/dag.ts"],
    "src/graph/dag.ts": [],
  });
  const map = mapOf([
    { slug: "generation", files: ["src/llm/writer.ts", "src/service/svc.ts"] },
    { slug: "graph", files: ["src/graph/dag.ts"] },
  ]);
  const domains = buildDomainEntities(code, map);

  it("creates one domain entity per map entry plus a single project entity", () => {
    expect(Object.keys(domains).sort()).toEqual(["domain:generation", "domain:graph", "project:"]);
    expect(domains["domain:generation"].type).toBe("domain");
    expect(domains[PROJECT_ID].type).toBe("project");
  });

  it("gives a domain its member files and cross-domain dependency as directDeps", () => {
    const gen = domains["domain:generation"];
    expect(gen.directDeps).toContain("file:src/llm/writer.ts");
    expect(gen.directDeps).toContain("file:src/service/svc.ts");
    expect(gen.directDeps).toContain("domain:graph");
    expect(domains["domain:graph"].directUsages).toEqual(["domain:generation"]);
  });

  it("gives the project every domain as directDeps", () => {
    expect(domains[PROJECT_ID].directDeps.sort()).toEqual(["domain:generation", "domain:graph"]);
  });

  it("flips the deps facet when membership changes", () => {
    const withExtra = indexFromDeps({
      "src/service/svc.ts": ["src/llm/writer.ts"],
      "src/llm/writer.ts": ["src/graph/dag.ts"],
      "src/llm/extra.ts": [],
      "src/graph/dag.ts": [],
    });
    const extraMap = mapOf([
      { slug: "generation", files: ["src/llm/writer.ts", "src/service/svc.ts", "src/llm/extra.ts"] },
      { slug: "graph", files: ["src/graph/dag.ts"] },
    ]);
    const before = domains["domain:generation"].facets.deps;
    const after = buildDomainEntities(withExtra, extraMap)["domain:generation"].facets.deps;
    expect(after).not.toBe(before);
  });

  it("skips a domain whose members are all absent from the index", () => {
    const built = buildDomainEntities(code, mapOf([{ slug: "ghost", files: ["src/gone.ts"] }]));
    expect(built["domain:ghost"]).toBeUndefined();
  });

  it("carries the domain block set and full_page role in metadata", () => {
    expect(domains["domain:generation"].metadata?.allowedBlocks).toEqual(DOMAIN_BLOCKS);
    expect(domains["domain:generation"].metadata?.role).toBe("full_page");
  });

  it("classifies tier entities as non-source", () => {
    expect(isSourceCodeEntity(domains["domain:generation"])).toBe(false);
    expect(isSourceCodeEntity(domains[PROJECT_ID])).toBe(false);
    expect(isSourceCodeEntity({ type: "function" })).toBe(true);
  });
});
