import { describe, expect, it } from "vitest";
import type { ChatCompletionInput, ChatCompletionProvider, ChatCompletionResult } from "./provider.js";
import { translateBlocks, translationBlockKey, translationNeedsWork } from "./translator.js";

function provider(responses: string[]): ChatCompletionProvider & { calls: number } {
  return {
    name: "stub",
    model: "stub",
    writerBudget: { maxPromptTokens: 100000, charsPerToken: 4, maxSectionsPerChunk: 6 },
    calls: 0,
    async complete(_input: ChatCompletionInput): Promise<ChatCompletionResult> {
      const content = responses[Math.min(this.calls, responses.length - 1)];
      this.calls += 1;
      return { content };
    },
  };
}

function capturingProvider(
  responses: string[]
): ChatCompletionProvider & { calls: number; inputs: ChatCompletionInput[] } {
  return {
    name: "stub",
    model: "stub",
    writerBudget: { maxPromptTokens: 100000, charsPerToken: 4, maxSectionsPerChunk: 6 },
    calls: 0,
    inputs: [],
    async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
      this.inputs.push(input);
      const content = responses[Math.min(this.calls, responses.length - 1)];
      this.calls += 1;
      return { content };
    },
  };
}

function response(text: string): string {
  return JSON.stringify({ sections: { s1: { blocks: { purpose: { text } } } } });
}

const input = {
  language: "en",
  blocks: [{ sectionId: "s1", blockId: "purpose" as const, heading: "Purpose", text: "Вызывает `foo()` из `bar`." }],
};

describe("translateBlocks", () => {
  it("accepts a translation that preserves every code span", async () => {
    const result = await translateBlocks(provider([response("Calls `foo()` from `bar`.")]), input);
    expect(result.get(translationBlockKey("s1", "purpose"))).toBe("Calls `foo()` from `bar`.");
  });

  it("drops a translation that loses a code span after repair also fails", async () => {
    const p = provider([response("Calls foo from bar.")]); // every attempt loses the backticks
    const result = await translateBlocks(p, input);
    expect(result.has(translationBlockKey("s1", "purpose"))).toBe(false);
    expect(p.calls).toBe(2); // initial + one repair
  });

  it("recovers via the repair round when the first attempt mangles a span", async () => {
    const p = provider([response("Calls foo from bar."), response("Calls `foo()` from `bar`.")]);
    const result = await translateBlocks(p, input);
    expect(result.get(translationBlockKey("s1", "purpose"))).toBe("Calls `foo()` from `bar`.");
    expect(p.calls).toBe(2);
  });

  it("drops a translation that introduces a code span not in the source", async () => {
    const result = await translateBlocks(provider([response("Calls `foo()` from `bar` via `baz`.")]), input);
    expect(result.has(translationBlockKey("s1", "purpose"))).toBe(false);
  });

  it("rejects an untranslated echo of the source (model returned it unchanged)", async () => {
    const echo = "Вызывает `foo()` из `bar`.";
    const result = await translateBlocks(provider([response(echo)]), input);
    expect(result.has(translationBlockKey("s1", "purpose"))).toBe(false);
  });

  it("re-requests a block the model omitted from the first batch response", async () => {
    const twoBlocks = {
      language: "en",
      blocks: [
        { sectionId: "s1", blockId: "purpose" as const, heading: "Purpose", text: "Делает `a`." },
        { sectionId: "s1", blockId: "limitations" as const, heading: "Limitations", text: "Не делает `b`." },
      ],
    };
    const first = JSON.stringify({ sections: { s1: { blocks: { purpose: { text: "Does `a`." } } } } });
    const repair = JSON.stringify({ sections: { s1: { blocks: { limitations: { text: "Does not `b`." } } } } });
    const p = provider([first, repair]);

    const result = await translateBlocks(p, twoBlocks);

    expect(result.get(translationBlockKey("s1", "purpose"))).toBe("Does `a`.");
    expect(result.get(translationBlockKey("s1", "limitations"))).toBe("Does not `b`.");
    expect(p.calls).toBe(2); // initial batch + one repair that supplied the omitted block
  });

  it("includes target-language writing rules and preferred terms in translation requests", async () => {
    const p = capturingProvider([response("Calls `foo()` from `bar`.")]);

    await translateBlocks(p, {
      ...input,
      writingRules: ["Use dry engineering prose."],
      terms: ["block", "section", "stale"],
    });

    const user = p.inputs[0]?.messages[1]?.content ?? "";
    expect(user).toContain("Writing rules:");
    expect(user).toContain("- Use dry engineering prose.");
    expect(user).toContain("Preferred target-language terms:");
    expect(user).toContain("block, section, stale");
  });
});

describe("translationNeedsWork", () => {
  it("flags an echoed translation of a block that has prose", () => {
    expect(translationNeedsWork("Calls `foo()`.", "Calls `foo()`.")).toBe(true);
  });

  it("accepts a real translation that preserves code spans", () => {
    expect(translationNeedsWork("Вызывает `foo()`.", "Calls `foo()`.")).toBe(false);
  });

  it("allows an identical code-only block (nothing to translate)", () => {
    expect(translationNeedsWork("`foo()` `bar`", "`foo()` `bar`")).toBe(false);
  });

  it("flags a translation that drops a code span", () => {
    expect(translationNeedsWork("Calls `foo()`.", "Вызывает foo.")).toBe(true);
  });
});
