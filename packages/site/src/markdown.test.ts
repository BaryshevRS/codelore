import { describe, expect, it } from "vitest";

import { transformDocument } from "./markdown.js";

describe("transformDocument", () => {
  it("adds title frontmatter and rewrites known documentation links", () => {
    const result = transformDocument({
      docPath: "src/alpha.codelore.md",
      markdown: `# Alpha module

See the [overview](../overview.codelore.md#usage), [another document](beta.codelore.md#api), and [Vitest](https://vitest.dev/guide/).
`,
      routeByDocPath: new Map([
        ["overview.codelore.md", "/docs"],
        ["src/alpha.codelore.md", "/docs/src/alpha"],
        ["src/beta.codelore.md", "/docs/src/beta"],
      ]),
    });

    expect(result).toMatch(/^---\ntitle: Alpha module\n---\n/);
    expect(result).not.toMatch(/^# Alpha module$/m);
    expect(result).toContain("[overview](/docs#usage)");
    expect(result).toContain("[another document](/docs/src/beta#api)");
    expect(result).toContain("[Vitest](https://vitest.dev/guide/)");
  });

  it("rejects links to unknown local Codelore documents", () => {
    expect(() =>
      transformDocument({
        docPath: "src/alpha.codelore.md",
        markdown: "# Alpha module\n\n[Missing](missing.codelore.md)",
        routeByDocPath: new Map([
          ["src/alpha.codelore.md", "/docs/src/alpha"],
        ]),
      }),
    ).toThrow(/unknown.*codelore.*document|codelore.*document.*unknown/i);
  });
});
