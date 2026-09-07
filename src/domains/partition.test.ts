import { describe, expect, it } from "vitest";
import { CodeloreError } from "../errors.js";
import { buildPartitionRequest, parsePartitionResponse } from "./partition.js";

const KNOWN = new Set(["a.ts", "b.ts", "c.ts"]);

function good(): string {
  return JSON.stringify({
    domains: [
      { slug: "core", name: "Ядро", rationale: "основа", files: ["a.ts", "b.ts"] },
      { slug: "util", name: "Утилиты", rationale: "хелперы", files: ["c.ts"] },
    ],
  });
}

describe("buildPartitionRequest", () => {
  it("wraps files and edges in inert-data tags and carries the response schema", () => {
    const req = buildPartitionRequest({
      files: [{ path: "a.ts", lead: "делает A" }],
      edges: [["a.ts", "b.ts"]],
      language: "ru",
      writingRules: ["коротко"],
    });
    const user = req.messages[1].content;
    expect(user).toContain("<files>\na.ts — делает A\n</files>");
    expect(user).toContain("<edges>\na.ts -> b.ts\n</edges>");
    expect(user).toContain("коротко");
    expect(req.responseSchema?.name).toBe("domain_partition");
  });
});

describe("parsePartitionResponse", () => {
  it("parses a valid full partition, sorted by slug", () => {
    const map = parsePartitionResponse(good(), KNOWN);
    expect(map.domains.map((d) => d.slug)).toEqual(["core", "util"]);
    expect(map.domains[0]).toMatchObject({ name: "Ядро", rationale: "основа", files: ["a.ts", "b.ts"] });
  });

  it("rejects a non-kebab slug", () => {
    const bad = JSON.stringify({ domains: [{ slug: "Core_1", name: "n", rationale: "r", files: ["a.ts"] }] });
    expect(() => parsePartitionResponse(bad, KNOWN)).toThrow(CodeloreError);
  });

  it("rejects an unknown file", () => {
    const bad = JSON.stringify({ domains: [{ slug: "core", name: "n", rationale: "r", files: ["z.ts"] }] });
    expect(() => parsePartitionResponse(bad, KNOWN)).toThrow(/unknown file/);
  });

  it("rejects a file assigned to two domains", () => {
    const bad = JSON.stringify({
      domains: [
        { slug: "core", name: "n", rationale: "r", files: ["a.ts", "b.ts", "c.ts"] },
        { slug: "util", name: "n", rationale: "r", files: ["a.ts"] },
      ],
    });
    expect(() => parsePartitionResponse(bad, KNOWN)).toThrow(/both/);
  });

  it("rejects an incomplete partition (a file left unassigned)", () => {
    const bad = JSON.stringify({ domains: [{ slug: "core", name: "n", rationale: "r", files: ["a.ts", "b.ts"] }] });
    expect(() => parsePartitionResponse(bad, KNOWN)).toThrow(/not assigned/);
  });

  it("rejects a duplicate slug", () => {
    const bad = JSON.stringify({
      domains: [
        { slug: "core", name: "n", rationale: "r", files: ["a.ts"] },
        { slug: "core", name: "n", rationale: "r", files: ["b.ts", "c.ts"] },
      ],
    });
    expect(() => parsePartitionResponse(bad, KNOWN)).toThrow(/Duplicate/);
  });
});
