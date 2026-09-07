import { describe, expect, it } from "vitest";
import {
  type BuildDomainWriteRequestInput,
  buildDomainWriteRequest,
  parseDomainWriteResponse,
} from "./domain-writer.js";

function input(overrides: Partial<BuildDomainWriteRequestInput> = {}): BuildDomainWriteRequestInput {
  return {
    tier: { id: "domain:doc-generation", name: "Doc generation", kind: "domain", rationale: "writes docs" },
    targetBlocks: ["purpose", "responsibility", "dependencies", "workflows", "limitations"],
    existingBlocks: [],
    members: [
      {
        label: "src/llm/file-writer.ts",
        sections: [{ heading: "buildFileWriteRequest", purpose: "builds the request" }],
      },
    ],
    dependencies: [{ name: "Transport", purpose: "sends chat completions" }],
    language: "ru",
    ...overrides,
  };
}

describe("buildDomainWriteRequest", () => {
  it("carries the tier id, members, and dependencies into the request; schema targets the section", () => {
    const request = buildDomainWriteRequest(input());
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("domain:doc-generation");
    expect(user).toContain("src/llm/file-writer.ts");
    expect(user).toContain("<members>");
    expect(user).toContain("<dependencies>");
    expect(request.responseSchema?.name).toBe("file_write");
  });

  it("omits the dependencies segment and dependency block for the project tier", () => {
    const request = buildDomainWriteRequest(
      input({
        tier: { id: "project:", name: "overview", kind: "project" },
        targetBlocks: ["purpose", "responsibility", "workflows", "limitations"],
        dependencies: [],
        members: [{ label: "Doc generation", sections: [{ heading: "Doc generation", purpose: "writes docs" }] }],
      })
    );
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    const all = request.messages.map((message) => message.content).join("\n");
    expect(user).not.toContain("<dependencies>");
    expect(all).toContain("project overview");
  });
});

describe("parseDomainWriteResponse", () => {
  it("parses blocks scoped to the tier section id with scores", () => {
    const content = JSON.stringify({
      sections: {
        "domain:doc-generation": {
          blocks: {
            purpose: {
              text: "Turns member docs into a subsystem chapter.",
              refs: ["src/llm/file-writer.ts"],
              novelFact: "n",
              informativeness: 1,
              novelty: 0.75,
              specificity: 0.75,
            },
            responsibility: {
              text: "Owns the writer/verify loop for tier prose.",
              refs: [],
              novelFact: "n",
              informativeness: 0.75,
              novelty: 0.75,
              specificity: 0.75,
            },
          },
        },
      },
    });
    const result = parseDomainWriteResponse(content, input());
    expect(result["domain:doc-generation"]?.purpose?.text).toContain("subsystem chapter");
    expect(result["domain:doc-generation"]?.purpose?.informativeness).toBe(1);
  });

  it("throws when a required block is missing", () => {
    const content = JSON.stringify({ sections: { "domain:doc-generation": { blocks: {} } } });
    expect(() => parseDomainWriteResponse(content, input())).toThrow(/missing required blocks/i);
  });
});
