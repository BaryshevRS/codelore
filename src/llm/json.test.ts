import { describe, expect, it } from "vitest";
import { CodeloreError } from "../errors.js";
import { parseJsonObject } from "./json.js";

describe("parseJsonObject", () => {
  it("parses well-formed JSON", () => {
    expect(parseJsonObject('{"a":1,"b":"x"}', "msg")).toEqual({ a: 1, b: "x" });
  });

  it("strips an outer ```json fence", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```', "msg")).toEqual({ a: 1 });
  });

  it("strips an outer ``` fence without the json tag", () => {
    expect(parseJsonObject('```\n{"a":1}\n```', "msg")).toEqual({ a: 1 });
  });

  it("repairs the LLM-emitted backtick template-literal escape", () => {
    expect(parseJsonObject('{"a":"use \\`code\\` here"}', "msg")).toEqual({
      a: "use `code` here",
    });
  });

  it("repairs the LLM-emitted dollar template-literal escape", () => {
    expect(parseJsonObject('{"a":"value is \\$amount"}', "msg")).toEqual({
      a: "value is $amount",
    });
  });

  it("preserves a single-backslash regex dot so the regex semantics survive", () => {
    expect(parseJsonObject('{"pattern":"matches /\\.json$/"}', "msg")).toEqual({
      pattern: "matches /\\.json$/",
    });
  });

  it("does not double an already-escaped backslash before a dot", () => {
    expect(parseJsonObject('{"pattern":"matches /\\\\.json$/"}', "msg")).toEqual({
      pattern: "matches /\\.json$/",
    });
  });

  it("never corrupts valid JSON that legitimately contains the repairable patterns", () => {
    // A doc describing the escape-repair itself: \\` and \\$ are valid JSON escapes
    // (backslash + char) and must survive parsing untouched.
    const content = '{"a":"patterns: \\\\` and \\\\$ and \\\\."}';
    expect(parseJsonObject(content, "msg")).toEqual({ a: "patterns: \\` and \\$ and \\." });
  });

  it("throws INVALID_LLM_RESPONSE on truncated JSON without silently closing it", () => {
    try {
      parseJsonObject('{"a":"truncated', "msg");
    } catch (error) {
      expect(error).toBeInstanceOf(CodeloreError);
      const codeloreError = error as CodeloreError;
      expect(codeloreError.code).toBe("INVALID_LLM_RESPONSE");
      expect(typeof codeloreError.details?.cause).toBe("string");
      return;
    }
    throw new Error("expected parseJsonObject to throw");
  });

  it("throws INVALID_LLM_RESPONSE on trailing commas (the retry loop is expected to recover this)", () => {
    expect(() => parseJsonObject('{"a":1,"b":2,}', "msg")).toThrowError(
      expect.objectContaining({ code: "INVALID_LLM_RESPONSE" })
    );
  });

  it("throws INVALID_LLM_RESPONSE for arrays at top level", () => {
    expect(() => parseJsonObject("[1,2,3]", "expected object")).toThrowError(
      expect.objectContaining({ code: "INVALID_LLM_RESPONSE" })
    );
  });

  it("throws INVALID_LLM_RESPONSE for primitives", () => {
    expect(() => parseJsonObject('"just a string"', "msg")).toThrowError(
      expect.objectContaining({ code: "INVALID_LLM_RESPONSE" })
    );
  });

  it("includes the original response head and parser cause on unrecoverable input", () => {
    try {
      parseJsonObject("totally not json at all [[[", "msg");
    } catch (error) {
      expect(error).toBeInstanceOf(CodeloreError);
      const codeloreError = error as CodeloreError;
      expect(codeloreError.code).toBe("INVALID_LLM_RESPONSE");
      expect(codeloreError.details?.response).toContain("totally not json at all");
      expect(typeof codeloreError.details?.cause).toBe("string");
      return;
    }
    throw new Error("expected parseJsonObject to throw");
  });
});
