import { describe, expect, it } from "vitest";
import { generateDomainDoc } from "./domain-pipeline.js";
import type { BuildDomainWriteRequestInput } from "./domain-writer.js";
import type { ChatCompletionInput, ChatCompletionProvider, ChatCompletionResult } from "./provider.js";

function providerReturning(responses: string[]): ChatCompletionProvider {
  let call = 0;
  return {
    name: "fake",
    model: "fake",
    writerBudget: { maxPromptTokens: 100000, charsPerToken: 4, maxSectionsPerChunk: 20 },
    async complete(_input: ChatCompletionInput): Promise<ChatCompletionResult> {
      const content = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { content };
    },
  };
}

const input: BuildDomainWriteRequestInput = {
  tier: { id: "domain:d", name: "D", kind: "domain" },
  targetBlocks: ["purpose", "responsibility"],
  existingBlocks: [],
  members: [{ label: "src/a.ts", sections: [{ heading: "a", purpose: "does a" }] }],
  dependencies: [],
  language: "en",
};

const writerResponse = JSON.stringify({
  sections: {
    "domain:d": {
      blocks: {
        purpose: {
          text: "Delivers capability A.",
          refs: [],
          novelFact: "n",
          informativeness: 1,
          novelty: 1,
          specificity: 1,
        },
        responsibility: {
          text: "Owns A end to end.",
          refs: [],
          novelFact: "n",
          informativeness: 1,
          novelty: 1,
          specificity: 1,
        },
      },
    },
  },
});

describe("generateDomainDoc", () => {
  it("keeps blocks the verifier does not contradict", async () => {
    const provider = providerReturning([writerResponse]);
    const verify = providerReturning(['{"contradictions":[]}']);
    const result = await generateDomainDoc({
      input,
      memberEvidence: "src/a.ts a: does a",
      provider,
      verifyProvider: verify,
    });
    expect(Object.keys(result.blocks).sort()).toEqual(["purpose", "responsibility"]);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops a block the verifier contradicts against the member docs", async () => {
    const provider = providerReturning([writerResponse]);
    const verify = providerReturning([
      '{"contradictions":[{"sectionId":"domain:d","blockId":"responsibility","statement":"Owns A end to end.","evidence":"member does only b"}]}',
    ]);
    const result = await generateDomainDoc({
      input,
      memberEvidence: "src/a.ts a: does a",
      provider,
      verifyProvider: verify,
    });
    expect(Object.keys(result.blocks)).toEqual(["purpose"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.blockId).toBe("responsibility");
  });

  it("retries the writer with feedback when the first response is invalid JSON", async () => {
    const provider = providerReturning([`${writerResponse} trailing junk`, writerResponse]);
    const verify = providerReturning(['{"contradictions":[]}']);
    const result = await generateDomainDoc({ input, memberEvidence: "e", provider, verifyProvider: verify });
    expect(Object.keys(result.blocks).sort()).toEqual(["purpose", "responsibility"]);
  });
});
