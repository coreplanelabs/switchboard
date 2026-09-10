// The diagrams' one visual system (docs/reference/specs/docs-site.md item 21).
//
// Every diagram in the tree is a ```mermaid fence, drawn by the site in its own
// palette (theme/MermaidDiagram.vue) and by GitHub in its defaults, so a fence
// carries structure and words only. Two diagrams are drawn in more than one
// place — the four seams (README, Architecture, How a request flows) and the
// deploy order (Worker topology, Ship a release) — and a copy is where drift
// starts, so both are rendered here from one source each and written into
// generated regions by `npm run docs:gen`, the way the reference tables are.
// The seams' statement lives with the site theme (docs/.vitepress/theme/seams.mjs,
// which the landing page reads too); the generator hands it in, because a
// production module under src/ imports nothing outside src/ — the bot's image
// copies src/ alone. The rules every other fence must keep are
// `diagramProblems`, held over the tree by src/docs/diagrams.test.ts.
//
// Pure: data in, markdown out. No fs, no clock.
import { DEPLOY_ORDER, type WorkerName } from "../deploy/plan.js";

export type SeamId = "channel" | "agent" | "provider" | "executor";

/** One seam as the theme states it — the shape of an entry in seams.mjs. */
export interface Seam {
  id: SeamId;
  /** The seam's name as the docs capitalise it: `Channel`. */
  name: string;
  /** What the seam is, lower-case, for a diagram title: `Channel — how a request arrives`. */
  role: string;
  /** The landing card's bold first sentence. */
  lead: string;
  /** The landing card's paragraph. */
  body: string;
  /** What stands behind the seam today, in the order the docs list them. */
  implementations: ReadonlyArray<string>;
  /** The site path of the page that goes deeper. */
  link: string;
  /** The link's text. */
  cta: string;
}

/** The one component that is not a seam: it sits between them and decides. */
export interface Dispatcher {
  name: string;
  does: ReadonlyArray<string>;
}

/** What the shared diagrams are drawn from; the generator assembles it. */
export interface DiagramSources {
  seams: ReadonlyArray<Seam>;
  dispatcher: Dispatcher;
  deployOrder: ReadonlyArray<WorkerName>;
}

/** `Slack · CLI · HTTP · MCP` — a list as one line, the separator every diagram and card uses. */
export const listed = (items: ReadonlyArray<string>): string => items.join(" · ");

/** A fence, ready to sit in a generated region. */
function fence(lines: readonly string[]): string {
  return ["```mermaid", ...lines, "```"].join("\n");
}

const seam = (seams: ReadonlyArray<Seam>, id: SeamId): Seam => {
  const found = seams.find((s) => s.id === id);
  if (!found) throw new Error(`the seams have no '${id}' — the four-seam diagram needs one`);
  return found;
};

/** `subgraph channel ["Channel — how a request arrives"]` — a seam as a titled cluster. */
const cluster = (s: Seam) => `    subgraph ${s.id} ["${s.name} — ${s.role}"]`;

/**
 * The four-seam diagram: a request crosses the channel, the dispatcher, the
 * agent, and from the agent the provider and the executor, left to right. The
 * channel's implementations are separate nodes because each is a way in; the
 * other seams list theirs in one node. No reply edges: a back-edge in an LR
 * flowchart folds under the forward ones on GitHub, and the prose beside every
 * copy says the reply travels the same path back.
 */
export function renderFourSeams(seams: ReadonlyArray<Seam>, dispatcher: Dispatcher): string {
  const channel = seam(seams, "channel");
  const agent = seam(seams, "agent");
  const provider = seam(seams, "provider");
  const executor = seam(seams, "executor");
  const ways = channel.implementations.map((label, i) => ({ id: `C${i + 1}`, label }));
  return fence([
    "flowchart LR",
    cluster(channel),
    ...ways.map((w) => `        ${w.id}["${w.label}"]`),
    "    end",
    `    D{"${dispatcher.name}<br/>${listed(dispatcher.does)}"}`,
    cluster(agent),
    `        AG["${listed(agent.implementations)}"]`,
    "    end",
    cluster(provider),
    `        P["${listed(provider.implementations)}"]`,
    "    end",
    cluster(executor),
    `        E["${listed(executor.implementations)}"]`,
    "    end",
    `    ${ways.map((w) => w.id).join(" & ")} -->|"message"| D`,
    '    D -->|"runs"| AG',
    '    AG <-->|"complete"| P',
    '    AG <-->|"bash · read · write"| E',
  ]);
}

/** What a Worker's node says beyond its name — only the one whose name is not what the docs call it. */
const WORKER_LABEL: Readonly<Record<WorkerName, string>> = {
  memory: "memory<br/>the state Worker",
  bot: "bot",
  resident: "resident",
  sandbox: "sandbox",
};

/** The deploy order, left to right, one double-bordered node per Worker — from `DEPLOY_ORDER`, never typed. */
export function renderDeployOrder(order: ReadonlyArray<WorkerName> = DEPLOY_ORDER): string {
  const nodes = order.map((name, i) => `W${i + 1}[["${WORKER_LABEL[name]}"]]`);
  return fence(["flowchart LR", `    ${nodes.join(" --> ")}`]);
}

/** The note in each region's opening marker: what draws it, so a reader of the raw markdown edits the source. */
export const DIAGRAM_REGION_NOTE =
  "npm run docs:gen — drawn from docs/.vitepress/theme/seams.mjs and src/deploy/plan.ts, do not edit by hand";

const fourSeams = (s: DiagramSources) => renderFourSeams(s.seams, s.dispatcher);
const deployOrder = (s: DiagramSources) => renderDeployOrder(s.deployOrder);

/** File (relative to `docs/`; the README is one level up) → region → renderer over the sources. */
export const DIAGRAM_REGIONS: Readonly<Record<string, Readonly<Record<string, (sources: DiagramSources) => string>>>> =
  {
    "../README.md": { "four-seams": fourSeams },
    "explanation/architecture.md": { "four-seams": fourSeams },
    "explanation/how-a-request-flows.md": { "four-seams": fourSeams },
    "explanation/worker-topology.md": { "deploy-order": deployOrder },
    "how-to/ship-a-release.md": { "deploy-order": deployOrder },
  };

/** One ```mermaid fence in a markdown file, with the line its opening sits on (1-based). */
export interface Fence {
  line: number;
  source: string;
}

/** Every ```mermaid fence in a markdown text — the fence at a line's start, its body up to the closing fence. */
export function mermaidFences(markdown: string): Fence[] {
  const fences: Fence[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^```mermaid\s*$/.test(lines[i])) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
    fences.push({ line: start + 1, source: body.join("\n") });
  }
  return fences;
}

/** The shape openers a flowchart node can start with. The lookahead refuses a
 *  quote (the label is quoted — good) and a second bracket (so `[[` cannot be
 *  re-read as `[` followed by `[` when the two-character opener is quoted). */
const NODE_OPENER = /\b[A-Za-z][A-Za-z0-9_]*\s*(\[\[|\[\(|\(\[|\(\(|\{\{|\[|\(|\{|>)(?!["[({])/g;
/** An edge label opener: the `|` right after an arrow. */
const EDGE_LABEL = /(?:-->|---|-\.->|<-->|==>|-\.-)\|(?!")/;

/**
 * What is wrong with one fence against the visual system — each problem a
 * sentence naming the rule, so the test's failure reads as the fix:
 *
 * - a flowchart runs `LR` (a path across the system) or `TB` (a stack); never
 *   `TD`, `RL`, `BT`, and never the older `graph` keyword;
 * - no `style`, `classDef`, `class`, `linkStyle` or `%%{init}` line — the
 *   site's theme owns the colours and GitHub renders its defaults;
 * - no `%%` comment — GitHub's renderer has misread them;
 * - every node label and every edge label is quoted, so punctuation inside
 *   one (`/`, `(`, `·`) is text, not syntax;
 * - no HTML in a label but `<br/>`, and no `#` — GitHub renders neither as
 *   the author meant.
 */
export function diagramProblems(source: string): string[] {
  const problems: string[] = [];
  const lines = source.split("\n");
  const header = lines.find((l) => l.trim() !== "")?.trim() ?? "";
  const flowchart = /^(flowchart|graph)\b/.test(header);
  if (flowchart) {
    const m = /^(flowchart|graph)\s*(\S*)/.exec(header);
    if (m?.[1] === "graph") problems.push(`'${header}' — write \`flowchart LR\` or \`flowchart TB\`, not \`graph\``);
    else if (m?.[2] !== "LR" && m?.[2] !== "TB")
      problems.push(`'${header}' — a flowchart runs LR (a path) or TB (a stack); never TD, RL or BT`);
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(style|classDef|class|linkStyle)\b/.test(line) || line.startsWith("%%{"))
      problems.push(`'${line}' — no colours or styles in a diagram; the site's theme owns them`);
    else if (line.startsWith("%%")) problems.push(`'${line}' — no %% comments; GitHub's renderer has misread them`);
    if (flowchart) {
      // A quoted label is text: a `(` or `[` inside one is not a shape opener.
      const syntax = line.replace(/"[^"]*"/g, '""');
      for (const m of syntax.matchAll(NODE_OPENER)) problems.push(`'${line}' — quote the label after '${m[1]}'`);
      if (EDGE_LABEL.test(syntax)) problems.push(`'${line}' — quote the edge label`);
    }
    if (/<(?!br\s*\/?>)[a-zA-Z]/.test(line)) problems.push(`'${line}' — no HTML in a label but <br/>`);
    if (line.includes("#")) problems.push(`'${line}' — no # in a diagram; GitHub reads it as an entity`);
  }
  return problems;
}
