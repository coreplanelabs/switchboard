import { fromMarkdown } from "mdast-util-from-markdown";
import type { OutputType } from "./types.js";

// The prose output type (docs/reference/specs/llm-output.md item 3). There is no invalid
// Markdown — every string renders as something — so this type never fails and
// never retries; what it fixes is DIALECT variance. Models alternate between
// `*x*` (mrkdwn bold) and `**x**` (Markdown bold), and per-surface renderers
// disagreed on which was meant (bold on Slack, italic on the run page).
// Canonicalization promotes single-asterisk emphasis to strong so every
// projector receives one dialect: asterisk emphasis = bold, `_x_` = italic.

type MdNode = {
  type: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

function hasMarkerDescendant(node: MdNode): boolean {
  for (const child of node.children ?? []) {
    if (child.type === "emphasis" || child.type === "strong") return true;
    if (hasMarkerDescendant(child)) return true;
  }
  return false;
}

/** Collect the `*` insertion offsets that promote a qualifying emphasis node
 *  to strong. A node qualifies only when its marker is `*` (an `_x_` IS
 *  italic), it is not part of a `***bold-italic***` run, and it neither sits
 *  under nor contains another emphasis/strong — rewriting nested marker runs
 *  (`**a *b* c**` → `**a **b** c**`) re-parses ambiguously, so those stay as
 *  written (fail-open; the Slack projector renders single-`*` bold anyway). */
function collectPromotions(node: MdNode, underMarker: boolean, raw: string, inserts: number[]): void {
  const isMarker = node.type === "emphasis" || node.type === "strong";
  if (node.type === "emphasis" && !underMarker) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      start !== undefined &&
      end !== undefined &&
      raw[start] === "*" &&
      raw[start + 1] !== "*" &&
      !hasMarkerDescendant(node)
    ) {
      inserts.push(start, end);
    }
  }
  for (const child of node.children ?? []) collectPromotions(child, underMarker || isMarker, raw, inserts);
}

/** Canonicalize Markdown prose: `*x*` → `**x**`, positionally — two `*`
 *  insertions at the emphasis node's boundaries, every other byte identical.
 *  Parser-guided (never regex): a `*` inside a code fence or inline code is
 *  not emphasis to the parser, so it is never touched. A parser throw returns
 *  the input unchanged — prose is fail-open by construction. */
export function canonicalizeMarkdown(raw: string): string {
  let tree: MdNode;
  try {
    tree = fromMarkdown(raw) as MdNode;
  } catch {
    return raw;
  }
  const inserts: number[] = [];
  collectPromotions(tree, false, raw, inserts);
  if (inserts.length === 0) return raw;
  let out = raw;
  for (const offset of inserts.sort((a, b) => b - a)) {
    out = `${out.slice(0, offset)}*${out.slice(offset)}`;
  }
  return out;
}

/** Markdown prose as an OutputType: `parse` always succeeds (`value` IS the
 *  canonical text), `changed` reports whether normalization touched anything. */
export const markdownOutput: OutputType<string> = {
  name: "markdown",
  parse(raw) {
    const canonical = canonicalizeMarkdown(raw);
    return { ok: true, value: canonical, canonical, changed: canonical !== raw };
  },
  retryable: () => false,
  maxRetries: 0,
};
