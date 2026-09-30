/** Exact GitHub pull requests named in a plain-words batch request. */
export interface BatchPullRequest {
  repo: string;
  number: number;
  url: string;
}

const TARGET_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?(?:[?#][^\s]*)?$/i;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const LINK_TOKEN = /^(?:<https?:\/\/[^\s>|]+(?:\|[^>]+)?>|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>,;]+)/i;
const CONTEXT_ONLY =
  /\b(?:do\s+not|don't|dont|not|except|excluding|exclude|for\s+context|context\s+only|background|reference|see\s+also|related)\b/i;

/** A link's destination alone is a target; its display label never contributes URLs. */
function targetOfToken(token: string, kind: "review" | "ship"): BatchPullRequest | undefined {
  let destination = token;
  let label: string | undefined;
  if (token.startsWith("<")) {
    const separator = token.indexOf("|");
    destination = token.slice(1, separator === -1 ? -1 : separator);
    if (separator !== -1) label = token.slice(separator + 1, -1);
  } else if (token.startsWith("[")) {
    const separator = token.indexOf("](");
    label = token.slice(1, separator);
    destination = token.slice(separator + 2, -1);
  }
  const match = TARGET_URL.exec(destination);
  if (match === null) return undefined;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  if (label !== undefined && CONTEXT_ONLY.test(label)) return undefined;
  if (kind === "ship" && token.startsWith("[") && !new RegExp(`#${number}\\b`).test(label ?? "")) return undefined;
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

/** A batch is an explicit action on several linked PRs, not incidental links. */
export function prBatchOf(text: string): { kind: "review" | "ship"; targets: BatchPullRequest[] } | undefined {
  const ask = text.replace(/^\s*(?:<@[^>]+>\s*)?(?:agent:conductor\s+)?(?:please\s+)?(?:can you\s+)?/i, "");
  const action = ask.match(/^((?:re-)?review|ship)\s+(?:(?:all\s+)?(?:of\s+)?)?(?:these|those|the following)\b/i);
  if (action === null) return undefined;
  const kind = action[1]!.toLowerCase() === "ship" ? "ship" : "review";
  const lines = ask.slice(action[0].length).replace(CODE, " ").split("\n");
  const targets: BatchPullRequest[] = [];
  const seen = new Set<string>();
  const include = (target: BatchPullRequest) => {
    const key = `${target.repo}#${target.number}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  let inList = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">")) continue;
    const bullet = /^(?:[-*•]|\d+[.)])\s+/.exec(trimmed);
    if (bullet === null && index > 0 && inList) break;
    if (bullet !== null) inList = true;
    if (index > 0 && bullet === null) continue;
    const item = bullet === null ? trimmed : trimmed.slice(bullet[0].length);
    if (item.startsWith(">")) continue;
    if (bullet !== null) {
      const token = LINK_TOKEN.exec(item)?.[0];
      if (token !== undefined && item.slice(token.length).trim() === "") {
        const target = targetOfToken(token, kind);
        if (target !== undefined) include(target);
      }
      continue;
    }
    // Inline requests may join links with commas or "and"; prose after them
    // cannot add another target.
    let rest = item.replace(/^:\s*/, "");
    while (rest.length > 0) {
      const token = LINK_TOKEN.exec(rest)?.[0];
      if (token === undefined) break;
      const target = targetOfToken(token, kind);
      if (target === undefined) break;
      include(target);
      const tail = rest.slice(token.length);
      const separator = /^\s*(?:,|and)\s*/i.exec(tail);
      if (separator === null) break;
      rest = tail.slice(separator[0].length);
    }
  }
  return targets.length >= 2 ? { kind, targets } : undefined;
}
