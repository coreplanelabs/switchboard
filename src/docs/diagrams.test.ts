// @vitest-environment happy-dom
// mermaid's parser wants a `document` even to parse; happy-dom is the one the
// dashboard's tests already run under, and parsing a fence here is the only
// proof short of a browser that it draws — the site build compiles the page
// but renders no diagram, and GitHub renders on its own.
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOY_ORDER } from "../deploy/plan.js";
import { DISPATCHER, SEAMS } from "../../docs/.vitepress/theme/seams.mjs";
import {
  DIAGRAM_REGION_NOTE,
  DIAGRAM_REGIONS,
  diagramProblems,
  mermaidFences,
  renderDeployOrder,
  renderFourSeams,
  type DiagramSources,
  type Fence,
} from "./diagrams.js";
import { declaredRegions, replaceRegion } from "./regions.js";

// Under happy-dom `import.meta.url` is a page URL, not a file one; the suite runs from the repository root.
const DOCS = resolve(process.cwd(), "docs");
/** What the generator draws from — the theme's statement and the deploy plan's order. */
const SOURCES: DiagramSources = { seams: SEAMS, dispatcher: DISPATCHER, deployOrder: DEPLOY_ORDER };

/** Every hand-written markdown file whose diagrams must keep the system: the
 *  README and the docs tree minus the records (immutable) and the build. */
function pages(): string[] {
  const inDocs = globSync("**/*.md", { cwd: DOCS }).filter(
    (rel) =>
      !rel.startsWith("node_modules/") &&
      !rel.startsWith(".vitepress/") &&
      !rel.startsWith("decisions/") &&
      !rel.startsWith("plans/"),
  );
  return ["../README.md", ...inDocs];
}

const read = (rel: string) => readFileSync(`${DOCS}/${rel}`, "utf8");

describe("renderFourSeams", () => {
  const out = renderFourSeams(SEAMS, DISPATCHER);

  it("draws the channel's ways in as separate nodes, every other seam as one node, and the dispatcher between them, from the seams' one statement", () => {
    expect(out.startsWith("```mermaid\nflowchart LR\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
    for (const seam of SEAMS) expect(out).toContain(`subgraph ${seam.id} ["${seam.name} — ${seam.role}"]`);
    const channel = SEAMS.find((s) => s.id === "channel")!;
    for (const way of channel.implementations) expect(out).toContain(`["${way}"]`);
    expect(out).toContain('AG["general · coding · review · ship · research · explore"]');
    expect(out).toContain('E["local · sandbox · resident"]');
    expect(out).toContain('D{"Dispatcher<br/>directives · config layers · authorization"}');
    expect(out).toContain('C1 & C2 & C3 -->|"message"| D');
    expect(out).toContain('AG <-->|"complete"| P');
  });

  it("keeps the visual system it asks of every other diagram", () => {
    expect(diagramProblems(mermaidFences(out)[0].source)).toEqual([]);
  });

  it("refuses a seam list missing one of the four", () => {
    expect(() =>
      renderFourSeams(
        SEAMS.filter((s) => s.id !== "executor"),
        DISPATCHER,
      ),
    ).toThrow(/no 'executor'/);
  });
});

describe("renderDeployOrder", () => {
  it("draws one double-bordered node per Worker, in DEPLOY_ORDER, left to right — a list nobody typed", () => {
    const out = renderDeployOrder();
    expect(out).toContain("flowchart LR");
    const nodes = [...out.matchAll(/W(\d)\[\["([^"]*)"\]\]/g)].map((m) => m[2].split("<br/>")[0]);
    expect(nodes).toEqual([...DEPLOY_ORDER]);
    expect(out).toContain('W1[["memory<br/>the state Worker"]] --> W2[["bot"]]');
    expect(diagramProblems(mermaidFences(out)[0].source)).toEqual([]);
  });
});

describe("mermaidFences", () => {
  it("finds each fence with the line it opens on, and leaves a fence mentioned in prose alone", () => {
    const md = [
      "# Title",
      "",
      "A ```mermaid fence is a diagram.",
      "",
      "```mermaid",
      "flowchart LR",
      '  A["a"]',
      "```",
      "",
      "```mermaid",
      "sequenceDiagram",
      "```",
    ].join("\n");
    expect(mermaidFences(md)).toEqual<Fence[]>([
      { line: 5, source: 'flowchart LR\n  A["a"]' },
      { line: 10, source: "sequenceDiagram" },
    ]);
  });
});

describe("diagramProblems", () => {
  it("accepts a flowchart that keeps the system: LR or TB, quoted labels, no styles", () => {
    const ok = [
      "flowchart TB",
      '    subgraph plane ["Control plane — the bot"]',
      '        BOT["Bot<br/>Slack + model keys"]',
      "    end",
      '    STATE[("State Worker")]',
      '    RW[["Resident Worker"]]',
      '    GH(["GitHub"])',
      '    HUMAN{{"Human triage"}}',
      '    D{"Dispatcher"}',
      '    BOT -->|"bearer"| STATE',
      '    BOT -.->|"redirect"| RW',
      '    BOT <-->|"complete (messages, tools)"| GH',
    ].join("\n");
    expect(diagramProblems(ok)).toEqual([]);
  });

  it("names a TD or graph header, a style line, a %% comment, an unquoted node or edge label, HTML and a #", () => {
    const problems = diagramProblems(
      [
        "flowchart TD",
        "    A[Spec row] --> B[Failing test]",
        "    A -->|unset?| B",
        '    C["<b>bold</b>"]',
        '    D["channel #general"]',
        "    style A fill:#fde68a",
        "    %% a comment",
      ].join("\n"),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("never TD, RL or BT"),
        expect.stringContaining("quote the label after '['"),
        expect.stringContaining("quote the edge label"),
        expect.stringContaining("no HTML in a label but <br/>"),
        expect.stringContaining("no # in a diagram"),
        expect.stringContaining("no colours or styles"),
        expect.stringContaining("no %% comments"),
      ]),
    );
    expect(diagramProblems("graph LR\n  A --> B")).toEqual([expect.stringContaining("not `graph`")]);
  });

  it("leaves a sequence diagram's arrows and a quoted label's punctuation alone", () => {
    expect(
      diagramProblems(
        [
          "sequenceDiagram",
          "    participant U as User (Slack)",
          '    U->>A: "agent:coding in acme/api: add retry"',
          "    A-->>U: reply",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      diagramProblems('flowchart LR\n    DEF["defineCommand({ id: (x) => y })"] -->|"derives"| CLI["CLI argv"]'),
    ).toEqual([]);
  });
});

describe("the diagrams in this tree", () => {
  const fences = pages().flatMap((rel) => mermaidFences(read(rel)).map((f) => ({ rel, ...f })));

  it("finds the fences (a glob that matches nothing would pass every assertion below)", () => {
    expect(fences.length).toBeGreaterThan(15);
    expect(fences.map((f) => f.rel)).toContain("../README.md");
  });

  it("every fence outside the records keeps the visual system", () => {
    const wrong = fences.flatMap((f) => diagramProblems(f.source).map((p) => `${f.rel}:${f.line} ${p}`));
    expect(wrong).toEqual([]);
  });

  it("every fence outside the records parses with mermaid", async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({ startOnLoad: false });
    const broken: string[] = [];
    for (const f of fences) {
      try {
        await mermaid.parse(f.source);
      } catch (e) {
        broken.push(`${f.rel}:${f.line} ${(e as Error).message.split("\n")[0]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("the four seams and the deploy order are the generator's output wherever they are drawn, and each file declares exactly its regions", () => {
    const stale: string[] = [];
    for (const [file, regions] of Object.entries(DIAGRAM_REGIONS)) {
      const text = read(file);
      expect(declaredRegions(text).sort()).toEqual(Object.keys(regions).sort());
      for (const [name, render] of Object.entries(regions)) {
        const outcome = replaceRegion(text, name, render(SOURCES), DIAGRAM_REGION_NOTE);
        if (!outcome.ok) stale.push(`${file}: ${outcome.problem}`);
        else if (outcome.changed) stale.push(`${file}: region '${name}' differs from the generator's output`);
      }
    }
    expect(stale).toEqual([]);
  });
});
