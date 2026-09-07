import { describe, expect, it } from "vitest";
import { buildAssignRequest, parseAssignResponse } from "./assign.js";

const known = new Set(["src/new.ts"]);
const slugs = new Set(["a", "b"]);

describe("buildAssignRequest", () => {
  it("lists the uncovered files and the existing domains as choices", () => {
    const request = buildAssignRequest({
      files: [{ path: "src/new.ts", lead: "does a new thing" }],
      domains: [{ slug: "a", name: "A", rationale: "handles A" }],
      language: "ru",
    });
    const user = request.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("src/new.ts");
    expect(user).toContain("a (A)");
    expect(request.responseSchema?.name).toBe("domain_assignment");
  });
});

describe("parseAssignResponse", () => {
  it("maps each file to its chosen existing domain", () => {
    const map = parseAssignResponse('{"assignments":[{"file":"src/new.ts","slug":"b"}]}', known, slugs);
    expect(map.get("src/new.ts")).toBe("b");
  });

  it("rejects an unknown slug", () => {
    expect(() => parseAssignResponse('{"assignments":[{"file":"src/new.ts","slug":"z"}]}', known, slugs)).toThrow(
      /unknown domain/i
    );
  });

  it("rejects an unknown file", () => {
    expect(() => parseAssignResponse('{"assignments":[{"file":"src/x.ts","slug":"a"}]}', known, slugs)).toThrow(
      /unknown file/i
    );
  });
});
