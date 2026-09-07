import { describe, expect, it } from "vitest";
import { collectMemberDocStaleBlocks } from "../service/stale-detection.js";
import type { CodeEntity, DocBlock, DocSection, ProjectIndex } from "../types.js";
import { collectDomainMemberEvidence, domainMemberFingerprint } from "./member-evidence.js";

function block(id: string, body: string): DocBlock {
  return { id, heading: id, depth: 2, body, rendered: true };
}

function fileSection(path: string, purpose: string): DocSection {
  return {
    id: `symbol:${path}#fn`,
    docPath: `${path}.codelore.md`,
    heading: "fn",
    depth: 1,
    anchor: "fn",
    owns: [`symbol:${path}#fn`],
    depends: [],
    usedBy: [],
    blocks: [block("purpose", purpose), block("responsibility", "does the work")],
    status: "normal",
    blockFingerprints: {},
    allowedBlocks: ["purpose", "responsibility"],
  };
}

function domainSection(fingerprint?: string): DocSection {
  return {
    id: "domain:d",
    docPath: "docs/domains/d.codelore.md",
    heading: "D",
    depth: 1,
    anchor: "d",
    owns: ["domain:d"],
    depends: ["file:src/a.ts"],
    usedBy: [],
    blocks: [block("purpose", "delivers A"), block("responsibility", "owns A")],
    status: "normal",
    blockFingerprints: {},
    allowedBlocks: ["purpose", "responsibility"],
    ...(fingerprint !== undefined ? { memberDocsFingerprint: fingerprint } : {}),
  };
}

function indexWith(memberPurpose: string, domainFingerprint?: string): ProjectIndex {
  const domainEntity: CodeEntity = {
    id: "domain:d",
    type: "domain",
    path: "d",
    name: "D",
    signature: "",
    range: { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 },
    directDeps: ["file:src/a.ts"],
    directUsages: [],
    contentHash: "h",
    facets: { signature: "s", body: "b", deps: "d", usage: "u", placement: "p" },
  };
  const member = fileSection("src/a.ts", memberPurpose);
  const domain = domainSection(domainFingerprint);
  return {
    version: 1,
    generatedAt: "",
    code: {
      version: 1,
      generatedAt: "",
      rootDir: "/r",
      entities: { "domain:d": domainEntity },
      fileToEntities: { "src/a.ts": ["file:src/a.ts", "symbol:src/a.ts#fn"] },
    },
    docs: {
      version: 1,
      generatedAt: "",
      rootDir: "/r",
      sections: { [member.id]: member, [domain.id]: domain },
      fileToSections: { "src/a.ts": [member.id] },
      entityToSections: { "domain:d": [domain.id], "symbol:src/a.ts#fn": [member.id] },
    },
  };
}

describe("collectDomainMemberEvidence", () => {
  it("is stable for the same member docs and changes when a member's prose changes", () => {
    const a = collectDomainMemberEvidence(indexWith("delivers A").code.entities["domain:d"], indexWith("delivers A"));
    const b = collectDomainMemberEvidence(indexWith("delivers A").code.entities["domain:d"], indexWith("delivers A"));
    const c = collectDomainMemberEvidence(indexWith("delivers B").code.entities["domain:d"], indexWith("delivers B"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("collectMemberDocStaleBlocks", () => {
  it("flags a tier doc when its member docs diverge from the stamped fingerprint", () => {
    const stamped = domainMemberFingerprint(
      collectDomainMemberEvidence(indexWith("delivers A").code.entities["domain:d"], indexWith("delivers A"))
    );
    const unchanged = indexWith("delivers A", stamped);
    expect(collectMemberDocStaleBlocks(Object.values(unchanged.docs.sections), unchanged)).toHaveLength(0);

    const changed = indexWith("delivers A — now with a caveat", stamped);
    const stale = collectMemberDocStaleBlocks(Object.values(changed.docs.sections), changed);
    expect(stale.map((entry) => entry.sectionId)).toEqual(["domain:d", "domain:d"]);
    expect(stale[0]?.changedFacets).toEqual(["memberDocs"]);
  });

  it("does not flag a tier doc that has no stamped fingerprint yet", () => {
    const index = indexWith("delivers A");
    expect(collectMemberDocStaleBlocks(Object.values(index.docs.sections), index)).toHaveLength(0);
  });
});
