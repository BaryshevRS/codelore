import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments.js";

describe("stripComments", () => {
  it("removes line and block comments including JSDoc", () => {
    const source = [
      "/** Doc comment. */",
      "function f() {",
      "  // inline claim",
      "  return 1; /* trailing */",
      "}",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).not.toContain("Doc comment");
    expect(stripped).not.toContain("inline claim");
    expect(stripped).not.toContain("trailing");
    expect(stripped).toContain("function f() {");
    expect(stripped).toContain("return 1;");
  });

  it("keeps comment-like content inside strings and templates", () => {
    const source = 'const a = "http://x // not a comment"; const b = `/* keep */`;';
    expect(stripComments(source)).toBe(source);
  });

  it("keeps regex literals containing slashes", () => {
    const source = "const re = /https:\\/\\/[a-z]+/g; const path = /(?:src|docs)\\/[\\w./@-]+/;";
    expect(stripComments(source)).toBe(source);
  });

  it("does not confuse division with regex", () => {
    const source = "const x = a / b / c; // strip me";
    const stripped = stripComments(source);
    expect(stripped).toContain("a / b / c;");
    expect(stripped).not.toContain("strip me");
  });

  it("collapses blank lines left by removed comment blocks", () => {
    const source = ["const a = 1;", "// one", "// two", "// three", "const b = 2;"].join("\n");
    expect(stripComments(source)).toBe("const a = 1;\n\nconst b = 2;");
  });
});
