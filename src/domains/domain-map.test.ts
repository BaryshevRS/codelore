import { describe, expect, it } from "vitest";
import { type DomainMap, domainCoverage, fileToDomainSlug } from "./domain-map.js";

function mapOf(domains: Array<{ slug: string; files: string[] }>): DomainMap {
  return { version: 1, generatedAt: "", domains: domains.map((d) => ({ ...d, name: d.slug })) };
}

describe("fileToDomainSlug", () => {
  it("maps each file to its domain, first assignment wins", () => {
    const map = mapOf([
      { slug: "a", files: ["x.ts", "y.ts"] },
      { slug: "b", files: ["y.ts", "z.ts"] },
    ]);
    const byFile = fileToDomainSlug(map);
    expect(byFile.get("x.ts")).toBe("a");
    expect(byFile.get("y.ts")).toBe("a");
    expect(byFile.get("z.ts")).toBe("b");
  });
});

describe("domainCoverage", () => {
  it("reports uncovered, double-assigned, and dangling files", () => {
    const map = mapOf([
      { slug: "a", files: ["x.ts", "shared.ts"] },
      { slug: "b", files: ["shared.ts", "gone.ts"] },
    ]);
    const cov = domainCoverage(map, ["x.ts", "shared.ts", "orphan.ts"]);
    expect(cov.uncovered).toEqual(["orphan.ts"]);
    expect(cov.doubleAssigned).toEqual([{ file: "shared.ts", slugs: ["a", "b"] }]);
    expect(cov.danglingFiles).toEqual([{ slug: "b", file: "gone.ts" }]);
  });

  it("is clean for a full one-to-one partition", () => {
    const map = mapOf([
      { slug: "a", files: ["x.ts"] },
      { slug: "b", files: ["y.ts"] },
    ]);
    const cov = domainCoverage(map, ["x.ts", "y.ts"]);
    expect(cov.uncovered).toEqual([]);
    expect(cov.doubleAssigned).toEqual([]);
    expect(cov.danglingFiles).toEqual([]);
  });
});
