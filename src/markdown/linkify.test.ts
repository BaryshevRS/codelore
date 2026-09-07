import { describe, expect, it } from "vitest";
import type { DocState, DocStateSection } from "../types.js";
import {
  addDocToLinkMap,
  type BlockLinkContext,
  buildDomainComposition,
  buildDomainRelations,
  buildEntityLinkMap,
  buildPathTargets,
  docLead,
  type FileDocTarget,
  type LinkTarget,
  linkifyBlockBody,
  removeDocFromLinkMap,
  sectionLinkTargets,
} from "./linkify.js";

const DOC_STATE_VERSION = 4;

function makeSection(overrides: Partial<DocStateSection> & { anchor: string; heading: string }): DocStateSection {
  return {
    depth: 1,
    owns: [],
    depends: [],
    usedBy: [],
    status: "normal",
    allowedBlocks: ["purpose"],
    blockOrder: ["purpose"],
    blocks: { purpose: { body: "Body.", rendered: true } },
    ...overrides,
  };
}

function makeState(docPath: string, sections: Record<string, DocStateSection>): DocState {
  return {
    version: DOC_STATE_VERSION,
    docPath,
    generatedAt: "2026-07-07T00:00:00.000Z",
    sectionOrder: Object.keys(sections),
    sections,
  };
}

const dagState = makeState("src/graph/file-dag.codelore.md", {
  "file:src/graph/file-dag.ts": makeSection({
    heading: "file-dag.ts",
    anchor: "file-dagts",
    owns: ["file:src/graph/file-dag.ts"],
  }),
  "symbol:src/graph/file-dag.ts#buildFileDag": makeSection({
    heading: "buildFileDag",
    anchor: "buildfiledag",
    owns: ["symbol:src/graph/file-dag.ts#buildFileDag"],
    usedBy: ["symbol:src/llm/file-pipeline.ts#collectDependencyDocs"],
  }),
});

const pipelineState = makeState("src/llm/file-pipeline.codelore.md", {
  "symbol:src/llm/file-pipeline.ts#collectDependencyDocs": makeSection({
    heading: "collectDependencyDocs",
    anchor: "collectdependencydocs",
    owns: ["symbol:src/llm/file-pipeline.ts#collectDependencyDocs"],
    depends: ["symbol:src/graph/file-dag.ts#buildFileDag"],
  }),
});

describe("buildEntityLinkMap", () => {
  it("maps every owned entity to its documenting section", () => {
    const links = buildEntityLinkMap([dagState, pipelineState]);
    expect(links.get("symbol:src/graph/file-dag.ts#buildFileDag")).toStrictEqual({
      docPath: "src/graph/file-dag.codelore.md",
      anchor: "buildfiledag",
    });
    expect(links.get("file:src/graph/file-dag.ts")).toStrictEqual({
      docPath: "src/graph/file-dag.codelore.md",
      anchor: "file-dagts",
    });
  });

  it("addDocToLinkMap replaces a doc's prior entries and removeDocFromLinkMap drops them", () => {
    const links = buildEntityLinkMap([dagState]);
    const moved = makeState("src/graph/file-dag.codelore.md", {
      "symbol:src/graph/file-dag.ts#buildFileDag": makeSection({
        heading: "buildFileDag",
        anchor: "renamed-anchor",
        owns: ["symbol:src/graph/file-dag.ts#buildFileDag"],
      }),
    });
    addDocToLinkMap(links, moved);
    expect(links.get("symbol:src/graph/file-dag.ts#buildFileDag")?.anchor).toBe("renamed-anchor");
    expect(links.has("file:src/graph/file-dag.ts")).toBe(false);

    removeDocFromLinkMap(links, "src/graph/file-dag.codelore.md");
    expect(links.size).toBe(0);
  });
});

describe("sectionLinkTargets", () => {
  const links = buildEntityLinkMap([dagState, pipelineState]);

  it("resolves depends mentions to the dependency's documenting section", () => {
    const section = pipelineState.sections["symbol:src/llm/file-pipeline.ts#collectDependencyDocs"];
    const targets = sectionLinkTargets(pipelineState, section, links);
    expect(targets.get("buildFileDag")).toStrictEqual({
      docPath: "src/graph/file-dag.codelore.md",
      anchor: "buildfiledag",
    });
  });

  it("resolves usedBy and same-doc mentions, but never the containing section itself", () => {
    const section = dagState.sections["symbol:src/graph/file-dag.ts#buildFileDag"];
    const targets = sectionLinkTargets(dagState, section, links);
    expect(targets.get("collectDependencyDocs")).toStrictEqual({
      docPath: "src/llm/file-pipeline.codelore.md",
      anchor: "collectdependencydocs",
    });
    expect(targets.has("buildFileDag")).toBe(false);
  });

  it("drops a name that resolves to more than one distinct target", () => {
    const otherParse = makeState("src/a.codelore.md", {
      "symbol:src/a.ts#parse": makeSection({ heading: "parse", anchor: "parse", owns: ["symbol:src/a.ts#parse"] }),
    });
    const consumer = makeState("src/c.codelore.md", {
      "symbol:src/c.ts#run": makeSection({
        heading: "run",
        anchor: "run",
        owns: ["symbol:src/c.ts#run"],
        depends: ["symbol:src/a.ts#parse", "symbol:src/b.ts#parse"],
      }),
    });
    const secondParse = makeState("src/b.codelore.md", {
      "symbol:src/b.ts#parse": makeSection({ heading: "parse", anchor: "parse", owns: ["symbol:src/b.ts#parse"] }),
    });
    const all = buildEntityLinkMap([otherParse, secondParse, consumer]);
    const targets = sectionLinkTargets(consumer, consumer.sections["symbol:src/c.ts#run"], all);
    expect(targets.has("parse")).toBe(false);
  });

  it("expands a file: id in usedBy to every entity documented in that file's doc", () => {
    const errorsDoc = makeState("src/errors.codelore.md", {
      "symbol:src/errors.ts#CodeloreError": makeSection({
        heading: "CodeloreError",
        anchor: "codeloreerror",
        owns: ["symbol:src/errors.ts#CodeloreError"],
        usedBy: ["file:src/cli/run-cli.ts"],
      }),
    });
    const cliDoc = makeState("src/cli/run-cli.codelore.md", {
      "file:src/cli/run-cli.ts": makeSection({
        heading: "run-cli.ts",
        anchor: "run-clits",
        owns: ["file:src/cli/run-cli.ts"],
      }),
      "symbol:src/cli/run-cli.ts#runCli": makeSection({
        heading: "runCli",
        anchor: "runcli",
        owns: ["symbol:src/cli/run-cli.ts#runCli"],
      }),
    });
    const all = buildEntityLinkMap([errorsDoc, cliDoc]);
    const targets = sectionLinkTargets(errorsDoc, errorsDoc.sections["symbol:src/errors.ts#CodeloreError"], all);
    expect(targets.get("runCli")).toStrictEqual({ docPath: "src/cli/run-cli.codelore.md", anchor: "runcli" });
  });

  it("exposes the bare method name for Class.method entities when unambiguous", () => {
    const classDoc = makeState("src/svc.codelore.md", {
      "symbol:src/svc.ts#Service.run": makeSection({
        heading: "Service.run",
        anchor: "servicerun",
        owns: ["symbol:src/svc.ts#Service.run"],
      }),
    });
    const consumer = makeState("src/c.codelore.md", {
      "symbol:src/c.ts#main": makeSection({
        heading: "main",
        anchor: "main",
        owns: ["symbol:src/c.ts#main"],
        depends: ["symbol:src/svc.ts#Service.run"],
      }),
    });
    const all = buildEntityLinkMap([classDoc, consumer]);
    const targets = sectionLinkTargets(consumer, consumer.sections["symbol:src/c.ts#main"], all);
    expect(targets.get("Service.run")?.anchor).toBe("servicerun");
    expect(targets.get("run")?.anchor).toBe("servicerun");
  });
});

describe("linkifyBlockBody", () => {
  const symbolTargets = new Map<string, LinkTarget>([
    ["buildFileDag", { docPath: "src/graph/file-dag.codelore.md", anchor: "buildfiledag" }],
    ["localHelper", { docPath: "src/llm/file-pipeline.codelore.md", anchor: "localhelper" }],
  ]);
  const pathTargets = new Map<string, LinkTarget>([
    ["src/graph/file-dag.ts", { docPath: "src/graph/file-dag.codelore.md", anchor: "file-dagts" }],
    ["src/llm/file-pipeline.ts", { docPath: "src/llm/file-pipeline.codelore.md", anchor: "file-pipelinets" }],
  ]);

  function makeContext(overrides: Partial<BlockLinkContext> = {}): BlockLinkContext {
    return {
      symbolTargets,
      pathTargets,
      selfTarget: { docPath: "src/llm/file-pipeline.codelore.md", anchor: "collectdependencydocs" },
      renderedDocPath: "src/llm/file-pipeline.codelore.md",
      renderedPathFor: (docPath: string): string => docPath,
      ...overrides,
    };
  }

  it("links a cross-doc mention with a relative path and anchor", () => {
    const out = linkifyBlockBody("Вызывает `buildFileDag` первым шагом.", makeContext());
    expect(out).toBe("Вызывает [`buildFileDag`](../graph/file-dag.codelore.md#buildfiledag) первым шагом.");
  });

  it("links a same-doc mention with an anchor-only href and keeps a () suffix", () => {
    const out = linkifyBlockBody("Использует `localHelper()`.", makeContext());
    expect(out).toBe("Использует [`localHelper()`](#localhelper).");
  });

  it("links a call-shaped mention with flat arguments but not nested parens", () => {
    const out = linkifyBlockBody("Шаг `buildFileDag(index.code)` и `files.filter((f) => dag.has(f))`.", makeContext());
    expect(out).toBe(
      "Шаг [`buildFileDag(index.code)`](../graph/file-dag.codelore.md#buildfiledag) и `files.filter((f) => dag.has(f))`."
    );
  });

  it("links a bare path mention to the file-level section, skipping paths inside code spans and self", () => {
    const out = linkifyBlockBody(
      'Строится в (src/graph/file-dag.ts), см. `import x from "src/graph/file-dag.ts"` и src/llm/file-pipeline.ts.',
      makeContext({ selfTarget: { docPath: "src/llm/file-pipeline.codelore.md", anchor: "file-pipelinets" } })
    );
    expect(out).toBe(
      'Строится в ([src/graph/file-dag.ts](../graph/file-dag.codelore.md#file-dagts)), см. `import x from "src/graph/file-dag.ts"` и src/llm/file-pipeline.ts.'
    );
  });

  it("links a path whose doc has no file-level section to the doc top (no anchor)", () => {
    const out = linkifyBlockBody(
      "Верхний обработчик в src/cli/run-cli.ts перехватывает ошибку.",
      makeContext({
        pathTargets: new Map([["src/cli/run-cli.ts", { docPath: "src/cli/run-cli.codelore.md" }]]),
      })
    );
    expect(out).toBe("Верхний обработчик в [src/cli/run-cli.ts](../cli/run-cli.codelore.md) перехватывает ошибку.");
  });

  it("keeps a path plain when the line already links a symbol into the same doc", () => {
    const out = linkifyBlockBody(
      "`buildFileDag` (src/graph/file-dag.ts) строит DAG; см. также src/llm/file-pipeline.ts.",
      makeContext({ selfTarget: { docPath: "src/a.codelore.md", anchor: "a" }, renderedDocPath: "src/a.codelore.md" })
    );
    expect(out).toBe(
      "[`buildFileDag`](graph/file-dag.codelore.md#buildfiledag) (src/graph/file-dag.ts) строит DAG; " +
        "см. также [src/llm/file-pipeline.ts](llm/file-pipeline.codelore.md#file-pipelinets)."
    );
  });

  it("suppresses a backtick path the same way and never links the same doc twice per line", () => {
    const out = linkifyBlockBody(
      "`buildFileDag` (`src/graph/file-dag.ts`) и повтор src/llm/file-pipeline.ts после src/llm/file-pipeline.ts.",
      makeContext({ selfTarget: { docPath: "src/a.codelore.md", anchor: "a" }, renderedDocPath: "src/a.codelore.md" })
    );
    expect(out).toBe(
      "[`buildFileDag`](graph/file-dag.codelore.md#buildfiledag) (`src/graph/file-dag.ts`) и повтор " +
        "[src/llm/file-pipeline.ts](llm/file-pipeline.codelore.md#file-pipelinets) после src/llm/file-pipeline.ts."
    );
  });

  it("links a backtick span that is entirely a source path, but not a path inside a larger code span", () => {
    const out = linkifyBlockBody(
      'В `src/graph/file-dag.ts` — строит граф; см. `import x from "src/graph/file-dag.ts"`.',
      makeContext({ selfTarget: { docPath: "src/llm/file-pipeline.codelore.md", anchor: "file-pipelinets" } })
    );
    expect(out).toBe(
      'В [`src/graph/file-dag.ts`](../graph/file-dag.codelore.md#file-dagts) — строит граф; см. `import x from "src/graph/file-dag.ts"`.'
    );
  });

  it("leaves unresolved mentions, non-symbol spans, and fenced code untouched", () => {
    const body =
      "Смотри `unknownName` и `a + b`.\n```ts\nconst x = buildFileDag(code);\n`buildFileDag`\n```\nПосле `buildFileDag`.";
    const out = linkifyBlockBody(body, makeContext());
    expect(out).toBe(
      "Смотри `unknownName` и `a + b`.\n```ts\nconst x = buildFileDag(code);\n`buildFileDag`\n```\nПосле [`buildFileDag`](../graph/file-dag.codelore.md#buildfiledag)."
    );
  });

  it("maps the target doc into the rendered language via renderedPathFor", () => {
    const toEnglish = (docPath: string): string => docPath.replace(/\.codelore\.md$/, ".en.codelore.md");
    const out = linkifyBlockBody(
      "Calls `buildFileDag`.",
      makeContext({ renderedDocPath: "src/llm/file-pipeline.en.codelore.md", renderedPathFor: toEnglish })
    );
    expect(out).toBe("Calls [`buildFileDag`](../graph/file-dag.en.codelore.md#buildfiledag).");
  });
});

describe("domain composition and relations", () => {
  const labels = { members: "Состав", dependsOn: "Зависит от", usedBy: "Используется в" };
  const links = new Map<string, LinkTarget>([
    ["domain:graph", { docPath: "docs/domains/graph.codelore.md", anchor: "граф" }],
    ["domain:orchestration", { docPath: "docs/domains/orchestration.codelore.md", anchor: "оркестрация" }],
  ]);
  const pathTargets = new Map<string, FileDocTarget>([
    ["src/llm/writer.ts", { docPath: "src/llm/writer.codelore.md" }],
  ]);
  const docInfo = new Map([
    ["src/llm/writer.codelore.md", { heading: "writer.ts", lead: "Пишет запрос к модели." }],
    ["docs/domains/graph.codelore.md", { heading: "Граф" }],
    ["docs/domains/orchestration.codelore.md", { heading: "Оркестрация" }],
  ]);
  const identity = (docPath: string): string => docPath;

  it("renders a domain's file members with one-line leads (domain deps are relations, not members)", () => {
    const comp = buildDomainComposition(
      ["file:src/llm/writer.ts", "domain:graph"],
      links,
      pathTargets,
      docInfo,
      "docs/domains/generation.codelore.md",
      identity,
      labels.members
    );
    expect(comp).toBe("## Состав\n\n- [writer](../../src/llm/writer.codelore.md) — Пишет запрос к модели.");
  });

  it("lists domains as project members using their display headings", () => {
    const comp = buildDomainComposition(
      ["domain:graph", "domain:orchestration"],
      links,
      pathTargets,
      docInfo,
      "overview.codelore.md",
      identity,
      labels.members
    );
    expect(comp).toBe(
      "## Состав\n\n- [Граф](docs/domains/graph.codelore.md#граф)\n- [Оркестрация](docs/domains/orchestration.codelore.md#оркестрация)"
    );
  });

  it("renders the relations line for a domain and nothing for the project", () => {
    const rel = buildDomainRelations(
      ["file:src/llm/writer.ts", "domain:graph"],
      ["domain:orchestration"],
      links,
      docInfo,
      "docs/domains/generation.codelore.md",
      identity,
      labels
    );
    expect(rel).toBe(
      "**Зависит от:** [Граф](graph.codelore.md#граф)\n**Используется в:** [Оркестрация](orchestration.codelore.md#оркестрация)"
    );
    expect(buildDomainRelations(["domain:graph"], [], links, docInfo, "overview.codelore.md", identity, labels)).toBe(
      ""
    );
  });

  it("drops undocumented members and returns empty when nothing resolves", () => {
    expect(
      buildDomainComposition(["file:src/gone.ts"], links, new Map(), docInfo, "d.md", identity, labels.members)
    ).toBe("");
  });
});

describe("docLead", () => {
  it("returns the first sentence of the first purpose block", () => {
    const state = makeState("src/a.codelore.md", {
      s1: makeSection({
        heading: "a.ts",
        anchor: "ats",
        blocks: { purpose: { body: "Делает X. И ещё Y.", rendered: true } },
      }),
    });
    expect(docLead(state)).toBe("Делает X.");
  });

  it("returns undefined when no section has purpose prose", () => {
    const state = makeState("src/a.codelore.md", {
      s1: makeSection({ heading: "a.ts", anchor: "ats", blocks: { purpose: { body: "", rendered: false } } }),
    });
    expect(docLead(state)).toBeUndefined();
  });
});

describe("buildPathTargets", () => {
  it("uses the file-level section's anchor when the doc has one", () => {
    const links = buildEntityLinkMap([dagState]);
    const paths = buildPathTargets(links);
    expect(paths.get("src/graph/file-dag.ts")).toStrictEqual({
      docPath: "src/graph/file-dag.codelore.md",
      anchor: "file-dagts",
    });
    expect(paths.size).toBe(1);
  });

  it("maps a symbol-only file to its doc top (no anchor)", () => {
    const symbolOnly = makeState("src/cli/run-cli.codelore.md", {
      "symbol:src/cli/run-cli.ts#runCli": makeSection({
        heading: "runCli",
        anchor: "runcli",
        owns: ["symbol:src/cli/run-cli.ts#runCli"],
      }),
    });
    const paths = buildPathTargets(buildEntityLinkMap([symbolOnly]));
    expect(paths.get("src/cli/run-cli.ts")).toStrictEqual({ docPath: "src/cli/run-cli.codelore.md" });
  });

  it("drops a source file documented across more than one doc", () => {
    const docA = makeState("src/a.codelore.md", {
      "symbol:src/shared.ts#one": makeSection({ heading: "one", anchor: "one", owns: ["symbol:src/shared.ts#one"] }),
    });
    const docB = makeState("src/b.codelore.md", {
      "symbol:src/shared.ts#two": makeSection({ heading: "two", anchor: "two", owns: ["symbol:src/shared.ts#two"] }),
    });
    const paths = buildPathTargets(buildEntityLinkMap([docA, docB]));
    expect(paths.has("src/shared.ts")).toBe(false);
  });
});
